// Server component of the Telegram Web UI plugin: records which users have seen which posts
// and reports view counts back to the web app. The data lives in its own table
// (tg_webui_user_view_tracking) and is only ever exposed through this plugin's HTTP API — the
// Mattermost web app itself knows nothing about it and stays unchanged.

package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
	"github.com/mattermost/mattermost/server/public/pluginapi"
)

const (
	// Endpoint path (relative to /plugins/com.telegramweb.ui): POST records views, GET reports
	// counts plus the caller's own seen state. GET can also return viewer IDs on demand.
	viewsPath = "/api/v1/views"
	// Searches every retained post in one channel. Unlike Mattermost's indexed /posts/search,
	// this is not subject to a server's search-result cap.
	channelSearchPath = "/api/v1/channel-search"
	forwardPath       = "/api/v1/forward"

	maxPostIDsPerRequest  = 100
	channelSearchPageSize = 100
)

type Plugin struct {
	plugin.MattermostPlugin

	client *pluginapi.Client
}

func (p *Plugin) OnActivate() error {
	p.client = pluginapi.NewClient(p.API, p.Driver)
	return p.ensureViewTable()
}

func (p *Plugin) ServeHTTP(_ *plugin.Context, w http.ResponseWriter, r *http.Request) {
	path := strings.TrimSuffix(r.URL.Path, "/")
	switch {
	case strings.HasSuffix(path, viewsPath):
		switch r.Method {
		case http.MethodPost:
			p.handleRecordViews(w, r)
		case http.MethodGet:
			p.handleViewStats(w, r)
		default:
			w.Header().Set("Allow", "GET, POST")
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	case strings.HasSuffix(path, channelSearchPath):
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		p.handleChannelSearch(w, r)
	case strings.HasSuffix(path, forwardPath):
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		p.handleForward(w, r)
	default:
		http.NotFound(w, r)
	}
}

// Forward a post with fresh file metadata so attachments remain attached to both posts.
func (p *Plugin) handleForward(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("Mattermost-User-Id")
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	var body struct {
		PostID    string `json:"post_id"`
		ChannelID string `json:"channel_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !model.IsValidId(body.PostID) || !model.IsValidId(body.ChannelID) {
		writeError(w, http.StatusBadRequest, "valid post_id and channel_id are required")
		return
	}
	source, appErr := p.API.GetPost(body.PostID)
	if appErr != nil || source == nil || source.DeleteAt != 0 || source.Type != "" {
		writeError(w, http.StatusNotFound, "post not found")
		return
	}
	if _, appErr = p.API.GetChannelMember(source.ChannelId, userID); appErr != nil {
		writeError(w, http.StatusForbidden, "source channel access required")
		return
	}
	if _, appErr = p.API.GetChannelMember(body.ChannelID, userID); appErr != nil || !p.API.HasPermissionToChannel(userID, body.ChannelID, model.PermissionCreatePost) {
		writeError(w, http.StatusForbidden, "destination posting permission required")
		return
	}
	var fileIDs []string
	if len(source.FileIds) > 0 {
		fileIDs, appErr = p.API.CopyFileInfos(userID, []string(source.FileIds))
		if appErr != nil {
			writeError(w, http.StatusInternalServerError, "could not copy attachments")
			return
		}
	}
	forwarded := &model.Post{
		UserId:    userID,
		ChannelId: body.ChannelID,
		Message:   source.Message,
		FileIds:   fileIDs,
		Props:     model.StringInterface{"tgw_forwarded_from": source.Id, "tgw_forwarded_user": source.UserId},
	}
	if author, authorErr := p.API.GetUser(source.UserId); authorErr == nil && author != nil {
		forwarded.Props["tgw_forwarded_name"] = author.Username
	}
	created, appErr := p.API.CreatePost(forwarded)
	if appErr != nil {
		writeError(w, http.StatusBadRequest, "could not forward post")
		return
	}
	writeJSON(w, created)
}

// handleChannelSearch scans the caller's own channel history rather than Mattermost's global
// text index. The membership check is essential: plugin endpoints run with server credentials,
// so callers must not be able to use one to read a channel they cannot access.
func (p *Plugin) handleChannelSearch(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("Mattermost-User-Id")
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var body struct {
		ChannelID string `json:"channel_id"`
		Term      string `json:"term"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	body.ChannelID = strings.TrimSpace(body.ChannelID)
	body.Term = strings.TrimSpace(body.Term)
	if body.ChannelID == "" || body.Term == "" {
		writeError(w, http.StatusBadRequest, "channel_id and term are required")
		return
	}
	if _, appErr := p.API.GetChannelMember(body.ChannelID, userID); appErr != nil {
		writeError(w, http.StatusForbidden, "channel access required")
		return
	}

	needle := strings.ToLower(body.Term)
	posts := make(map[string]*model.Post)
	order := make([]string, 0)
	seen := make(map[string]bool)
	for page := 0; ; page++ {
		postList, appErr := p.API.GetPostsForChannel(body.ChannelID, page, channelSearchPageSize)
		if appErr != nil {
			writeError(w, http.StatusInternalServerError, "could not load channel history")
			return
		}
		if postList == nil || len(postList.Order) == 0 {
			break
		}
		newPosts := false
		for _, id := range postList.Order {
			post := postList.Posts[id]
			if post == nil || seen[id] {
				continue
			}
			seen[id] = true
			newPosts = true
			if post.DeleteAt == 0 && strings.Contains(strings.ToLower(post.Message), needle) {
				posts[id] = post
				order = append(order, id)
			}
		}
		// Protect against a legacy server returning the same page for every page argument.
		if !newPosts {
			break
		}
	}

	writeJSON(w, map[string]any{"order": order, "posts": posts})
}

// --------------------------------------------------------------------------- handlers

func (p *Plugin) handleRecordViews(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("Mattermost-User-Id")
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var body struct {
		PostIDs []string `json:"post_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	ids := validPostIDs(body.PostIDs)
	if len(ids) == 0 {
		writeJSON(w, map[string]any{"recorded": 0})
		return
	}

	posts := map[string]*model.Post{}
	for _, id := range ids {
		post, appErr := p.API.GetPost(id)
		if appErr == nil && post != nil {
			posts[id] = post
		}
	}

	// A user may only record views inside channels they belong to.
	channelOK := map[string]bool{}
	now := model.GetMillis()
	recorded := 0
	for _, id := range ids {
		post, ok := posts[id]
		if !ok || post.DeleteAt > 0 {
			continue
		}
		allowed, seen := channelOK[post.ChannelId]
		if !seen {
			_, memberErr := p.API.GetChannelMember(post.ChannelId, userID)
			allowed = memberErr == nil
			channelOK[post.ChannelId] = allowed
		}
		if !allowed {
			continue
		}
		if err := p.recordView(userID, post.Id, post.ChannelId, now); err != nil {
			p.API.LogWarn("could not record view", "post_id", post.Id, "error", err.Error())
			continue
		}
		recorded++
	}

	writeJSON(w, map[string]any{"recorded": recorded})
}

func (p *Plugin) handleViewStats(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("Mattermost-User-Id")
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	ids := validPostIDs(strings.Split(r.URL.Query().Get("post_ids"), ","))
	if len(ids) == 0 {
		writeJSON(w, map[string]any{"counts": map[string]int{}, "seen": map[string]bool{}, "viewers": map[string][]string{}})
		return
	}
	// The endpoint runs with plugin credentials. Restrict even aggregate counts and viewer IDs
	// to posts in a channel the caller can currently access.
	ids = p.accessiblePostIDs(userID, ids)
	if len(ids) == 0 {
		writeJSON(w, map[string]any{"counts": map[string]int{}, "seen": map[string]bool{}, "viewers": map[string][]string{}})
		return
	}

	counts, err := p.viewCounts(ids)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not load view counts")
		return
	}
	seen, err := p.seenPostIDs(userID, ids)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not load seen state")
		return
	}

	response := map[string]any{"counts": counts, "seen": seen}
	if r.URL.Query().Get("include_viewers") == "true" {
		viewers, viewedAt, err := p.viewUserIDs(ids)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not load viewers")
			return
		}
		response["viewers"] = viewers
		response["viewed_at"] = viewedAt
	}
	writeJSON(w, response)
}

// --------------------------------------------------------------------------- helpers

func validPostIDs(ids []string) []string {
	out := make([]string, 0, len(ids))
	seen := map[string]bool{}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] || !model.IsValidId(id) {
			continue
		}
		seen[id] = true
		out = append(out, id)
		if len(out) == maxPostIDsPerRequest {
			break
		}
	}
	return out
}

// accessiblePostIDs filters a request through the current channel membership. The cache keeps a
// multi-post request from repeatedly looking up the same channel.
func (p *Plugin) accessiblePostIDs(userID string, ids []string) []string {
	channelOK := map[string]bool{}
	allowed := make([]string, 0, len(ids))
	for _, id := range ids {
		post, appErr := p.API.GetPost(id)
		if appErr != nil || post == nil || post.DeleteAt > 0 {
			continue
		}
		canRead, known := channelOK[post.ChannelId]
		if !known {
			_, memberErr := p.API.GetChannelMember(post.ChannelId, userID)
			canRead = memberErr == nil
			channelOK[post.ChannelId] = canRead
		}
		if canRead {
			allowed = append(allowed, id)
		}
	}
	return allowed
}

// inPlaceholders builds "(?, ?, ?)" / "($1, $2, $3)" for an IN list.
func (p *Plugin) inPlaceholders(start, count int) string {
	parts := make([]string, count)
	for i := 0; i < count; i++ {
		if p.client.Store.DriverName() == "postgres" {
			parts[i] = "$" + strconv.Itoa(start+i)
		} else {
			parts[i] = "?"
		}
	}
	return "(" + strings.Join(parts, ", ") + ")"
}

func (p *Plugin) ph(n int) string {
	if p.client.Store.DriverName() == "postgres" {
		return "$" + strconv.Itoa(n)
	}
	return "?"
}

func writeJSON(w http.ResponseWriter, payload any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"message": message})
}
