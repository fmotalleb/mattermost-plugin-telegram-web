package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/pluginapi/cluster"
)

const schedulePath = "/api/v1/scheduled-posts"
const scheduleKeyPrefix = "tgw_schedule_"
const schedulePostProp = "tgw_scheduled_id"
const maxScheduledPerUser = 100
const maxScheduledTotal = 500
const maxScheduledBytes = 16 * 1024 * 1024
const maxScheduleScanKeys = 1000
const maxReconciliationPages = 10

var errScheduleQuota = errors.New("Scheduled message queue limit reached. Remove pending messages before scheduling more.")

// Pending posts belong to this plugin, not Mattermost's licensed scheduled-posts service.
// StartedAt is saved before posting so a worker recovering after a crash can reconcile the
// channel history before attempting another delivery.
type scheduledPost struct {
	ID          string                `json:"id"`
	UserID      string                `json:"user_id"`
	ChannelID   string                `json:"channel_id"`
	Message     string                `json:"message"`
	RootID      string                `json:"root_id,omitempty"`
	FileIDs     []string              `json:"file_ids,omitempty"`
	Props       model.StringInterface `json:"props,omitempty"`
	Priority    *model.PostPriority   `json:"priority,omitempty"`
	ScheduledAt int64                 `json:"scheduled_at"`
	StartedAt   int64                 `json:"delivery_started_at,omitempty"`
	RetryAt     int64                 `json:"retry_at,omitempty"`
	Attempts    int                   `json:"attempts,omitempty"`
	ErrorCode   string                `json:"error_code,omitempty"`
}

// Low-level persistence; new client jobs must use enqueueScheduledPost for quotas.
func (p *Plugin) saveScheduledPost(post *scheduledPost) error {
	data, err := json.Marshal(post)
	if err != nil {
		return err
	}
	if appErr := p.API.KVSet(scheduleKeyPrefix+post.ID, data); appErr != nil {
		return appErr
	}
	return nil
}

// Collect a bounded key snapshot before delivering/deleting records. Unknown keys
// (including the cluster job's locks) are ignored.
func (p *Plugin) scheduledPosts() ([]*scheduledPost, error) {
	return p.scanScheduledPosts(context.Background())
}

func (p *Plugin) scanScheduledPosts(ctx context.Context) ([]*scheduledPost, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// Use one bounded key snapshot. Offset paging can skip live records if an
	// unrelated cluster-job lock key disappears between pages, even while queue
	// mutations are serialized. An ambiguous full page must fail closed.
	keys, appErr := p.API.KVList(0, maxScheduleScanKeys)
	if appErr != nil {
		return nil, appErr
	}
	if len(keys) >= maxScheduleScanKeys {
		return nil, fmt.Errorf("scheduled queue exceeds scan budget; remove excess records")
	}
	posts := []*scheduledPost{}
	seen := map[string]bool{}
	bytesRead := 0
	for _, key := range keys {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if seen[key] {
			return nil, fmt.Errorf("scheduled queue repeated a key")
		}
		seen[key] = true
		if !strings.HasPrefix(key, scheduleKeyPrefix) {
			continue
		}
		data, appErr := p.API.KVGet(key)
		if appErr != nil {
			return nil, appErr
		}
		if data == nil {
			continue
		}
		bytesRead += len(data)
		if len(data) > 65536 || bytesRead > 2*maxScheduledBytes {
			return nil, fmt.Errorf("scheduled queue exceeds byte budget")
		}
		var post scheduledPost
		if err := json.Unmarshal(data, &post); err != nil {
			p.API.LogWarn("invalid scheduled message record", "key", key)
			continue
		}
		posts = append(posts, &post)
	}
	return posts, nil
}

func (p *Plugin) handleScheduledPosts(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("Mattermost-User-Id")
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	if r.Context().Err() != nil {
		return
	}
	if !p.acquireWork(w) {
		return
	}
	defer p.releaseWork()
	if r.Method == http.MethodGet {
		posts, err := p.cachedScheduledPosts(r.Context())
		if err != nil {
			writeError(w, 500, "could not load scheduled messages")
			return
		}
		own := make([]*scheduledPost, 0)
		for _, post := range posts {
			if post.UserID == userID && (r.URL.Query().Get("channel_id") == "" || post.ChannelID == r.URL.Query().Get("channel_id")) {
				own = append(own, post)
			}
		}
		writeJSON(w, own)
		return
	}
	// Decode only user-controlled message fields. Sender, job ID and delivery state cannot be
	// supplied by a client, nor can props impersonate webhooks or override the sender's name.
	var body struct {
		ChannelID   string                `json:"channel_id"`
		Message     string                `json:"message"`
		RootID      string                `json:"root_id"`
		FileIDs     []string              `json:"file_ids"`
		Props       model.StringInterface `json:"props"`
		Priority    *model.PostPriority   `json:"priority"`
		ScheduledAt int64                 `json:"scheduled_at"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536))
	if err := decoder.Decode(&body); err != nil {
		writeError(w, 400, "invalid scheduled message")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, 400, "invalid JSON body")
		return
	}
	if !model.IsValidId(body.ChannelID) || (body.RootID != "" && !model.IsValidId(body.RootID)) || body.ScheduledAt <= model.GetMillis() ||
		(strings.TrimSpace(body.Message) == "" && len(body.FileIDs) == 0) || utf8.RuneCountInString(body.Message) > model.PostMessageMaxRunesV2 || len(body.FileIDs) > 10 || strings.HasPrefix(strings.TrimSpace(body.Message), "/") {
		writeError(w, 400, "a valid channel, message and future scheduled_at are required")
		return
	}
	if body.Priority != nil {
		priority := body.Priority
		if body.RootID != "" || priority.Priority == nil || (*priority.Priority != model.PostPriorityUrgent && *priority.Priority != "important") ||
			(priority.RequestedAck != nil && *priority.RequestedAck) || (priority.PersistentNotifications != nil && *priority.PersistentNotifications) {
			writeError(w, 400, "unsupported scheduled message priority")
			return
		}
		// Never persist the model's internal PostId/ChannelId fields from client JSON.
		level, no := *priority.Priority, false
		body.Priority = &model.PostPriority{Priority: &level, RequestedAck: &no, PersistentNotifications: &no}
	}
	post := &scheduledPost{ID: model.NewId(), UserID: userID, ChannelID: body.ChannelID, Message: body.Message,
		RootID: body.RootID, FileIDs: body.FileIDs, Priority: body.Priority, ScheduledAt: body.ScheduledAt}
	if voice, ok := body.Props["voice"].(map[string]any); ok {
		for _, id := range body.FileIDs {
			if voice["fileId"] == id {
				post.Props = model.StringInterface{"voice": voice}
				break
			}
		}
	}
	if err := p.validateScheduledPost(post); err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	// Leave headroom for worker bookkeeping within Mattermost's plugin KV value size limit.
	if data, err := json.Marshal(post); err != nil || len(data) > 60000 {
		writeError(w, 400, "scheduled message is too large")
		return
	}
	if err := p.enqueueScheduledPost(r.Context(), post); err != nil {
		if errors.Is(err, errScheduleQuota) {
			writeError(w, http.StatusTooManyRequests, err.Error())
			return
		}
		writeError(w, 500, "could not save scheduled message")
		return
	}
	if !setResponseHeader(w, "Content-Type", "application/json") {
		return
	}
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(post)
}

// Cancellation and the worker's delivery claim compete atomically for the same record.
// A successful cancellation can never be resurrected by a worker holding an older snapshot.
func (p *Plugin) handleDeleteScheduledPost(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodDelete {
		setResponseHeader(w, "Allow", "DELETE")
		writeError(w, 405, "method not allowed")
		return
	}
	userID := r.Header.Get("Mattermost-User-Id")
	if userID == "" {
		writeError(w, 401, "authentication required")
		return
	}
	if !model.IsValidId(id) {
		writeError(w, 400, "invalid scheduled message ID")
		return
	}
	if r.Context().Err() != nil {
		return
	}
	if !p.acquireWork(w) {
		return
	}
	defer p.releaseWork()
	data, appErr := p.API.KVGet(scheduleKeyPrefix + id)
	if appErr != nil {
		writeError(w, 500, "could not load scheduled message")
		return
	}
	var post scheduledPost
	if len(data) == 0 || json.Unmarshal(data, &post) != nil || post.UserID != userID {
		writeError(w, 404, "scheduled message not found")
		return
	}
	if post.StartedAt != 0 {
		if post.ErrorCode == "" {
			writeError(w, 409, "This message is already being delivered. Refresh the list.")
			return
		}
		delivered, err := p.scheduledPostDeliveredContext(r.Context(), &post)
		if err != nil || delivered {
			writeError(w, 409, "Could not safely cancel this delivery. Refresh the list.")
			return
		}
	}
	// Keep KVList offsets stable while another node checks admission quotas.
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	mutex, err := p.lockScheduleQueue(ctx)
	if err != nil {
		writeError(w, 500, "could not remove scheduled message")
		return
	}
	removed, appErr := p.API.KVCompareAndDelete(scheduleKeyPrefix+id, data)
	mutex.Unlock()
	if appErr != nil {
		writeError(w, 500, "could not remove scheduled message")
		return
	}
	if !removed {
		writeError(w, 409, "This scheduled message changed. Refresh the list and try again.")
		return
	}
	p.invalidateScheduledList()
	writeJSON(w, &post)
}

// Plugin APIs run with server privileges. Revalidate the sender's own access both when queuing
// and when delivering, rather than using that privilege to bypass channel/user restrictions.
func (p *Plugin) validateScheduledPost(post *scheduledPost) error {
	user, appErr := p.API.GetUser(post.UserID)
	if appErr != nil || user == nil || user.DeleteAt != 0 {
		return fmt.Errorf("sender is unavailable")
	}
	channel, appErr := p.API.GetChannel(post.ChannelID)
	if appErr != nil || channel == nil || channel.DeleteAt != 0 {
		return fmt.Errorf("channel is unavailable")
	}
	if member, appErr := p.API.GetChannelMember(post.ChannelID, post.UserID); appErr != nil || member == nil || !p.API.HasPermissionToChannel(post.UserID, post.ChannelID, model.PermissionCreatePost) {
		return fmt.Errorf("channel posting permission required")
	}
	if post.RootID != "" {
		root, appErr := p.API.GetPost(post.RootID)
		if appErr != nil || root == nil || root.DeleteAt != 0 || root.ChannelId != post.ChannelID || root.RootId != "" {
			return fmt.Errorf("thread is unavailable")
		}
	}
	if len(post.FileIDs) > 0 && !p.API.HasPermissionToChannel(post.UserID, post.ChannelID, model.PermissionUploadFile) {
		return fmt.Errorf("attachment permission required")
	}
	seen := make(map[string]bool)
	for _, id := range post.FileIDs {
		if !model.IsValidId(id) || seen[id] {
			return fmt.Errorf("invalid attachment")
		}
		seen[id] = true
		file, appErr := p.API.GetFileInfo(id)
		if appErr != nil || file == nil || file.DeleteAt != 0 || file.CreatorId != post.UserID || file.PostId != "" {
			return fmt.Errorf("attachment is unavailable or not owned by sender")
		}
	}
	return nil
}

func (p *Plugin) runScheduledPosts() {
	posts, err := p.scheduledPosts()
	if err != nil {
		p.API.LogWarn("could not load scheduled messages", "error", err.Error())
		return
	}
	now := model.GetMillis()
	for _, post := range posts {
		if post.ErrorCode != "" || post.ScheduledAt > now || post.RetryAt > now {
			continue
		}
		p.deliverScheduledPost(post, now)
	}
}

func (p *Plugin) failScheduledPost(post *scheduledPost, reason string, data []byte) {
	defer p.invalidateScheduledList()
	post.ErrorCode = reason
	updated, err := json.Marshal(post)
	if err != nil {
		return
	}
	if _, err := p.API.KVCompareAndSet(scheduleKeyPrefix+post.ID, data, updated); err != nil {
		p.API.LogWarn("could not persist scheduled message failure", "id", post.ID, "error", err.Error())
	}
	p.API.LogWarn("scheduled message was not delivered", "id", post.ID, "reason", reason)
}

func (p *Plugin) deliverScheduledPost(post *scheduledPost, now int64) {
	data, appErr := p.API.KVGet(scheduleKeyPrefix + post.ID)
	if appErr != nil || len(data) == 0 || json.Unmarshal(data, post) != nil || post.ErrorCode != "" {
		return
	}
	if post.StartedAt != 0 {
		// A crash or an RPC failure may happen after CreatePost committed but before its reply.
		// Look for our marker before retrying, even if the sender subsequently lost access.
		found, err := p.scheduledPostDelivered(post)
		if err != nil {
			p.API.LogWarn("could not reconcile scheduled message", "id", post.ID, "error", err.Error())
			return
		}
		if found {
			p.deleteDeliveredSchedule(post)
			return
		}
	}
	if post.Attempts >= 3 {
		p.failScheduledPost(post, "delivery_failed", data)
		return
	}
	if err := p.validateScheduledPost(post); err != nil {
		p.failScheduledPost(post, err.Error(), data)
		return
	}
	if post.StartedAt == 0 {
		post.StartedAt = now
	}
	post.Attempts++
	post.RetryAt = now + int64(post.Attempts)*30000
	updated, err := json.Marshal(post)
	if err != nil {
		return
	}
	claimed, appErr := p.API.KVCompareAndSet(scheduleKeyPrefix+post.ID, data, updated)
	if appErr != nil || !claimed {
		return
	}
	props := model.StringInterface{schedulePostProp: post.ID}
	if voice := post.Props["voice"]; voice != nil {
		props["voice"] = voice
	}
	outgoing := &model.Post{UserId: post.UserID, ChannelId: post.ChannelID, RootId: post.RootID, Message: post.Message, FileIds: post.FileIDs, Props: props}
	if post.Priority != nil {
		outgoing.Metadata = &model.PostMetadata{Priority: post.Priority}
	}
	created, appErr := p.API.CreatePost(outgoing)
	if appErr != nil || created == nil {
		p.API.LogWarn("scheduled delivery will be reconciled and retried", "id", post.ID)
		return
	}
	p.deleteDeliveredSchedule(post)
}

func (p *Plugin) deleteDeliveredSchedule(post *scheduledPost) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	mutex, err := p.lockScheduleQueue(ctx)
	if err != nil {
		p.API.LogWarn("could not lock scheduled message removal", "id", post.ID)
		return
	}
	appErr := p.API.KVDelete(scheduleKeyPrefix + post.ID)
	mutex.Unlock()
	p.invalidateScheduledList()
	if appErr != nil {
		p.API.LogWarn("could not remove delivered schedule", "id", post.ID)
	}
}

func (p *Plugin) scheduledPostDelivered(post *scheduledPost) (bool, error) {
	return p.scheduledPostDeliveredContext(context.Background(), post)
}
func (p *Plugin) scheduledPostDeliveredContext(ctx context.Context, post *scheduledPost) (bool, error) {
	seen := make(map[string]bool)
	for page := 0; page < maxReconciliationPages; page++ {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		list, appErr := p.API.GetPostsForChannel(post.ChannelID, page, 100)
		if err := ctx.Err(); err != nil {
			return false, err
		}
		if appErr != nil {
			return false, appErr
		}
		if list == nil || len(list.Order) == 0 {
			return false, nil
		}
		oldest := int64(1<<63 - 1)
		newPosts := false
		for _, id := range list.Order {
			candidate := list.Posts[id]
			if !seen[id] {
				newPosts = true
				seen[id] = true
			}
			if candidate == nil {
				continue
			}
			if candidate.UserId == post.UserID && candidate.GetProp(schedulePostProp) == post.ID {
				return true, nil
			}
			if candidate.CreateAt < oldest {
				oldest = candidate.CreateAt
			}
		}
		if !newPosts {
			return false, fmt.Errorf("channel history repeated a page")
		}
		// Allow one minute of clock skew. Stop once the possible delivery window
		// is exhausted; longer histories fail closed at the work budget below.
		if oldest < post.StartedAt-60000 || len(list.Order) < 100 {
			return false, nil
		}
	}
	// Failure to exhaust the history is NOT proof that delivery did not happen.
	// Never retry or confirm cancellation based on a truncated reconciliation.
	return false, fmt.Errorf("delivery reconciliation exceeds work budget; manual review required")
}

// Serialize additions and removals so admission evaluates a stable queue.
// Delivery bookkeeping has reserved byte headroom and cannot add records.
func (p *Plugin) enqueueScheduledPost(ctx context.Context, post *scheduledPost) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	mutex, err := p.lockScheduleQueue(ctx)
	if err != nil {
		return err
	}
	defer mutex.Unlock()
	posts, err := p.scanScheduledPosts(ctx)
	if err != nil {
		return err
	}
	own, size := 0, 0
	for _, queued := range posts {
		if queued.UserID == post.UserID {
			own++
		}
		data, err := json.Marshal(queued)
		if err != nil {
			return err
		}
		// Reserve room for worker delivery/failure bookkeeping.
		size += len(data) + 512
	}
	data, err := json.Marshal(post)
	if err != nil {
		return err
	}
	if own >= maxScheduledPerUser || len(posts) >= maxScheduledTotal || size+len(data)+512 > maxScheduledBytes {
		return errScheduleQuota
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := p.saveScheduledPost(post); err != nil {
		return err
	}
	p.invalidateScheduledList()
	return nil
}

// Coalesce list reads for a short interval so polling clients cannot each force a
// scan of the entire plugin KV namespace. Both the scan and cached bytes are bounded.
func (p *Plugin) cachedScheduledPosts(ctx context.Context) ([]*scheduledPost, error) {
	p.scheduleListMu.Lock()
	defer p.scheduleListMu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if time.Since(p.scheduleListAt) < 3*time.Second {
		return p.scheduleListCache, nil
	}
	posts, err := p.scanScheduledPosts(ctx)
	if err != nil {
		return nil, err
	}
	p.scheduleListCache = posts
	p.scheduleListAt = time.Now()
	return posts, nil
}
func (p *Plugin) invalidateScheduledList() {
	p.scheduleListMu.Lock()
	p.scheduleListCache = nil
	p.scheduleListAt = time.Time{}
	p.scheduleListMu.Unlock()
}

func (p *Plugin) lockScheduleQueue(ctx context.Context) (*cluster.Mutex, error) {
	mutex, err := cluster.NewMutex(p.API, "scheduled-admission")
	if err != nil {
		return nil, err
	}
	if err := mutex.LockWithContext(ctx); err != nil {
		return nil, err
	}
	return mutex, nil
}
