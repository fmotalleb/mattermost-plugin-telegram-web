package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

const scheduleUserID = "aaaaaaaaaaaaaaaaaaaaaaaaaa"
const scheduleChannelID = "bbbbbbbbbbbbbbbbbbbbbbbbbb"
const scheduleFileID = "cccccccccccccccccccccccccc"
const scheduleRootID = "dddddddddddddddddddddddddd"

type schedulingAPI struct {
	mu          sync.Mutex
	beforeClaim func()
	plugin.API
	data             map[string][]byte
	history          []*model.Post
	creates          []*model.Post
	allowed          bool
	deactivated      bool
	archived         bool
	foreignFile      bool
	foreignRoot      bool
	createError      bool
	ambiguousSuccess bool
	failSave         bool
	failRead         bool
	failDelete       bool
	historyError     bool
	historyReads     int
}

func scheduleTestPlugin() (*Plugin, *schedulingAPI) {
	api := &schedulingAPI{data: make(map[string][]byte), allowed: true}
	return &Plugin{MattermostPlugin: plugin.MattermostPlugin{API: api}}, api
}
func (a *schedulingAPI) LogWarn(string, ...any)  {}
func (a *schedulingAPI) LogError(string, ...any) {}
func (a *schedulingAPI) KVSetWithOptions(key string, value []byte, opts model.PluginKVSetOptions) (bool, *model.AppError) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.failSave {
		return false, &model.AppError{StatusCode: 500}
	}
	if opts.Atomic && !bytes.Equal(a.data[key], opts.OldValue) {
		return false, nil
	}
	if value == nil {
		delete(a.data, key)
	} else {
		a.data[key] = append([]byte(nil), value...)
	}
	return true, nil
}
func (a *schedulingAPI) KVSet(key string, data []byte) *model.AppError {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.failSave {
		return &model.AppError{StatusCode: 500}
	}
	a.data[key] = append([]byte(nil), data...)
	return nil
}
func (a *schedulingAPI) KVCompareAndSet(key string, old, next []byte) (bool, *model.AppError) {
	if a.beforeClaim != nil {
		hook := a.beforeClaim
		a.beforeClaim = nil
		hook()
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.failSave {
		return false, &model.AppError{StatusCode: 500}
	}
	if !bytes.Equal(a.data[key], old) {
		return false, nil
	}
	a.data[key] = append([]byte(nil), next...)
	return true, nil
}
func (a *schedulingAPI) KVCompareAndDelete(key string, old []byte) (bool, *model.AppError) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.failDelete {
		return false, &model.AppError{StatusCode: 500}
	}
	if !bytes.Equal(a.data[key], old) {
		return false, nil
	}
	delete(a.data, key)
	return true, nil
}
func (a *schedulingAPI) KVGet(key string) ([]byte, *model.AppError) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]byte(nil), a.data[key]...), nil
}
func (a *schedulingAPI) KVDelete(key string) *model.AppError {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.failDelete {
		return &model.AppError{StatusCode: 500}
	}
	delete(a.data, key)
	return nil
}
func (a *schedulingAPI) KVList(page, count int) ([]string, *model.AppError) {
	if a.failRead {
		return nil, &model.AppError{StatusCode: 500}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	keys := make([]string, 0, len(a.data))
	for key := range a.data {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	start := page * count
	if start >= len(keys) {
		return nil, nil
	}
	end := min(start+count, len(keys))
	return keys[start:end], nil
}
func (a *schedulingAPI) GetUser(id string) (*model.User, *model.AppError) {
	u := &model.User{Id: id}
	if a.deactivated {
		u.DeleteAt = 1
	}
	return u, nil
}
func (a *schedulingAPI) GetChannel(id string) (*model.Channel, *model.AppError) {
	c := &model.Channel{Id: id}
	if a.archived {
		c.DeleteAt = 1
	}
	return c, nil
}
func (a *schedulingAPI) GetChannelMember(channel, user string) (*model.ChannelMember, *model.AppError) {
	if !a.allowed {
		return nil, &model.AppError{StatusCode: 403}
	}
	return &model.ChannelMember{ChannelId: channel, UserId: user}, nil
}
func (a *schedulingAPI) HasPermissionToChannel(string, string, *model.Permission) bool {
	return a.allowed
}
func (a *schedulingAPI) GetFileInfo(id string) (*model.FileInfo, *model.AppError) {
	owner := scheduleUserID
	if a.foreignFile {
		owner = "another-user"
	}
	return &model.FileInfo{Id: id, CreatorId: owner}, nil
}
func (a *schedulingAPI) GetPost(id string) (*model.Post, *model.AppError) {
	channel := scheduleChannelID
	if a.foreignRoot {
		channel = "another-channel"
	}
	return &model.Post{Id: id, ChannelId: channel}, nil
}
func (a *schedulingAPI) CreatePost(post *model.Post) (*model.Post, *model.AppError) {
	a.creates = append(a.creates, post)
	if a.createError {
		return nil, &model.AppError{StatusCode: 500}
	}
	saved := post.Clone()
	saved.Id = model.NewId()
	saved.CreateAt = model.GetMillis()
	a.history = append(a.history, saved)
	if a.ambiguousSuccess {
		return nil, &model.AppError{StatusCode: 500}
	}
	return saved, nil
}
func (a *schedulingAPI) GetPostsForChannel(channel string, page, count int) (*model.PostList, *model.AppError) {
	a.historyReads++
	if a.historyError {
		return nil, &model.AppError{StatusCode: 500}
	}
	list := model.NewPostList()
	start := page * count
	for i := start; i < min(start+count, len(a.history)); i++ {
		list.AddPost(a.history[i])
		list.AddOrder(a.history[i].Id)
	}
	return list, nil
}
func postSchedule(p *Plugin, body map[string]any, user string) *httptest.ResponseRecorder {
	data, _ := json.Marshal(body)
	request := httptest.NewRequest(http.MethodPost, schedulePath, strings.NewReader(string(data)))
	if user != "" {
		request.Header.Set("Mattermost-User-Id", user)
	}
	response := httptest.NewRecorder()
	p.ServeHTTP(nil, response, request)
	return response
}
func validScheduleBody() map[string]any {
	return map[string]any{"channel_id": scheduleChannelID, "message": "send later", "scheduled_at": model.GetMillis() + 60000}
}
func TestScheduleAuthorizationAndValidation(t *testing.T) {
	for _, name := range []string{"anonymous", "valid", "past", "empty", "command", "no permission", "deactivated", "archived", "foreign attachment", "foreign thread", "sender spoof", "priority spoof", "oversize", "store failure"} {
		t.Run(name, func(t *testing.T) {
			p, api := scheduleTestPlugin()
			body := validScheduleBody()
			user := scheduleUserID
			want := 201
			switch name {
			case "anonymous":
				user = ""
				want = 401
			case "past":
				body["scheduled_at"] = 1
				want = 400
			case "empty":
				body["message"] = "  "
				want = 400
			case "command":
				body["message"] = "/help"
				want = 400
			case "no permission":
				api.allowed = false
				want = 403
			case "deactivated":
				api.deactivated = true
				want = 403
			case "archived":
				api.archived = true
				want = 403
			case "foreign attachment":
				body["file_ids"] = []string{scheduleFileID}
				api.foreignFile = true
				want = 403
			case "foreign thread":
				body["root_id"] = scheduleRootID
				api.foreignRoot = true
				want = 403
			case "sender spoof":
				body["user_id"] = "victim"
				body["props"] = map[string]any{"override_username": "victim", "from_webhook": "true"}
			case "priority spoof":
				body["priority"] = map[string]any{"priority": "urgent", "PostId": "victim", "ChannelId": "victim"}
			case "oversize":
				body["message"] = strings.Repeat("x", 70000)
				want = 400
			case "store failure":
				api.failSave = true
				want = 500
			}
			response := postSchedule(p, body, user)
			if response.Code != want {
				t.Fatalf("status=%d want=%d body=%s", response.Code, want, response.Body)
			}
			if len(api.creates) != 0 {
				t.Fatal("scheduled message sent immediately")
			}
			if want == 201 {
				var stored scheduledPost
				if err := json.Unmarshal(response.Body.Bytes(), &stored); err != nil {
					t.Fatal(err)
				}
				if stored.UserID != scheduleUserID || stored.Props["override_username"] != nil || !model.IsValidId(stored.ID) {
					t.Fatalf("unsafe stored post: %+v", stored)
				}
				if stored.Priority != nil && (stored.Priority.PostId != "" || stored.Priority.ChannelId != "") {
					t.Fatal("client supplied priority internals were not stripped")
				}
				if len(api.data) != 1 {
					t.Fatal("not persisted")
				}
				// A fresh plugin instance uses the same persisted queue after a restart.
				restarted := &Plugin{MattermostPlugin: plugin.MattermostPlugin{API: api}}
				restarted.deliverScheduledPost(&stored, stored.ScheduledAt)
				if len(api.creates) != 1 || len(api.data) != 0 {
					t.Fatal("restart did not deliver and remove the queued message")
				}
			} else if len(api.data) != 0 {
				t.Fatal("invalid request was persisted")
			}
		})
	}
}
func TestScheduledDelivery(t *testing.T) {
	for _, name := range []string{"future", "due", "permissions revoked", "user deleted", "channel archived", "KV failure", "ambiguous success", "delete failure", "transient failure", "reconcile failure", "max retries", "attachments and priority", "thread"} {
		t.Run(name, func(t *testing.T) {
			p, api := scheduleTestPlugin()
			now := model.GetMillis()
			post := &scheduledPost{ID: model.NewId(), UserID: scheduleUserID, ChannelID: scheduleChannelID, Message: "later", ScheduledAt: now - 1}
			switch name {
			case "future":
				post.ScheduledAt = now + 60000
			case "permissions revoked":
				api.allowed = false
			case "user deleted":
				api.deactivated = true
			case "channel archived":
				api.archived = true
			case "ambiguous success":
				api.ambiguousSuccess = true
			case "delete failure":
				api.failDelete = true
			case "transient failure":
				api.createError = true
			case "reconcile failure":
				post.StartedAt = now - 1000
				api.historyError = true
			case "max retries":
				post.StartedAt = now - 1000
				post.Attempts = 3
			case "attachments and priority":
				priority := "urgent"
				no := false
				post.FileIDs = []string{scheduleFileID}
				post.Priority = &model.PostPriority{Priority: &priority, RequestedAck: &no, PersistentNotifications: &no}
				post.Props = model.StringInterface{"voice": map[string]any{"fileId": scheduleFileID}}
			case "thread":
				post.RootID = scheduleRootID
			}
			if err := p.saveScheduledPost(post); err != nil {
				t.Fatal(err)
			}
			if name == "KV failure" {
				api.failSave = true
			}
			p.runScheduledPosts()
			if name == "future" || name == "permissions revoked" || name == "user deleted" || name == "channel archived" || name == "KV failure" || name == "reconcile failure" || name == "max retries" {
				if len(api.creates) != 0 {
					t.Fatal("should not deliver")
				}
				return
			}
			if len(api.creates) != 1 {
				t.Fatalf("creates=%d", len(api.creates))
			}
			created := api.creates[0]
			if created.UserId != scheduleUserID || created.GetProp(schedulePostProp) != post.ID {
				t.Fatal("wrong sender or missing recovery marker")
			}
			if name == "attachments and priority" && (len(created.FileIds) != 1 || created.Metadata.Priority == nil || created.GetProp("voice") == nil) {
				t.Fatal("lost attachment/voice/priority")
			}
			if name == "thread" && created.RootId != scheduleRootID {
				t.Fatal("lost thread")
			}
			if name == "ambiguous success" || name == "delete failure" || name == "transient failure" {
				data := api.data[scheduleKeyPrefix+post.ID]
				var retry scheduledPost
				_ = json.Unmarshal(data, &retry)
				api.failDelete = false
				api.createError = false
				p.deliverScheduledPost(&retry, now+60000)
				want := 1
				if name == "transient failure" {
					want = 2
				}
				if len(api.creates) != want || len(api.data) != 0 {
					t.Fatalf("retry duplicated or lost delivery: creates=%d jobs=%d", len(api.creates), len(api.data))
				}
			} else if len(api.data) != 0 {
				t.Fatal("delivered job remains queued")
			}
		})
	}
}
func TestScheduledListPrivacyAndPaging(t *testing.T) {
	p, api := scheduleTestPlugin()
	now := model.GetMillis()
	for i := 0; i < 205; i++ {
		post := &scheduledPost{ID: model.NewId(), UserID: scheduleUserID, ChannelID: scheduleChannelID, Message: "later", ScheduledAt: now - 1}
		if i == 0 {
			post.UserID = "another-user"
		}
		if err := p.saveScheduledPost(post); err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(http.MethodGet, schedulePath, nil)
	request.Header.Set("Mattermost-User-Id", scheduleUserID)
	response := httptest.NewRecorder()
	p.ServeHTTP(nil, response, request)
	var own []scheduledPost
	if err := json.Unmarshal(response.Body.Bytes(), &own); err != nil || len(own) != 204 {
		t.Fatalf("listing leaked or omitted jobs: %d err=%v", len(own), err)
	}
	p.runScheduledPosts()
	if len(api.creates) != 205 || len(api.data) != 0 {
		t.Fatalf("paging skipped jobs while deleting: creates=%d pending=%d", len(api.creates), len(api.data))
	}
}

func TestCancelScheduledPost(t *testing.T) {
	for _, tc := range []struct {
		name, user string
		started    bool
		fail       bool
		want       int
	}{
		{"owner", scheduleUserID, false, false, 200},
		{"anonymous", "", false, false, 401},
		{"another user", model.NewId(), false, false, 404},
		{"delivering", scheduleUserID, true, false, 409},
		{"storage error", scheduleUserID, false, true, 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &schedulingAPI{data: map[string][]byte{}, allowed: true, failDelete: tc.fail}
			p := &Plugin{}
			p.SetAPI(a)
			job := &scheduledPost{ID: model.NewId(), UserID: scheduleUserID, ChannelID: scheduleChannelID, Message: "cancel me", ScheduledAt: model.GetMillis() - 1}
			if tc.started {
				job.StartedAt = model.GetMillis()
			}
			if err := p.saveScheduledPost(job); err != nil {
				t.Fatal(err)
			}
			snapshot := *job
			req := httptest.NewRequest(http.MethodDelete, schedulePath+"/"+job.ID, nil)
			req.Header.Set("Mattermost-User-Id", tc.user)
			out := httptest.NewRecorder()
			p.ServeHTTP(nil, out, req)
			if out.Code != tc.want {
				t.Fatalf("status %d: %s", out.Code, out.Body.String())
			}
			if tc.want == 200 {
				p.deliverScheduledPost(&snapshot, model.GetMillis())
				if len(a.creates) != 0 || len(a.data) != 0 {
					t.Fatal("cancelled schedule was resurrected by stale worker snapshot")
				}
				var removed scheduledPost
				if err := json.Unmarshal(out.Body.Bytes(), &removed); err != nil || removed.Message != job.Message {
					t.Fatal("missing removed message for edit hydration")
				}
			} else if len(a.data) != 1 {
				t.Fatal("unsuccessful cancellation lost schedule")
			}
		})
	}
}

func TestCancellationWinsDeliveryClaim(t *testing.T) {
	a := &schedulingAPI{data: map[string][]byte{}, allowed: true}
	p := &Plugin{}
	p.SetAPI(a)
	job := &scheduledPost{ID: model.NewId(), UserID: scheduleUserID, ChannelID: scheduleChannelID, Message: "cancel race", ScheduledAt: model.GetMillis() - 1}
	if err := p.saveScheduledPost(job); err != nil {
		t.Fatal(err)
	}
	a.beforeClaim = func() {
		req := httptest.NewRequest(http.MethodDelete, schedulePath+"/"+job.ID, nil)
		req.Header.Set("Mattermost-User-Id", scheduleUserID)
		out := httptest.NewRecorder()
		p.ServeHTTP(nil, out, req)
		if out.Code != 200 {
			t.Fatalf("cancellation failed: %d", out.Code)
		}
	}
	p.deliverScheduledPost(job, model.GetMillis())
	if len(a.creates) != 0 || len(a.data) != 0 {
		t.Fatal("delivery claim ignored successful concurrent cancellation")
	}
}
