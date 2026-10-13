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
	// counts plus the caller's own seen state.
	viewsPath = "/api/v1/views"

	maxPostIDsPerRequest = 100
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
	default:
		http.NotFound(w, r)
	}
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
		writeJSON(w, map[string]any{"counts": map[string]int{}, "seen": map[string]bool{}})
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

	writeJSON(w, map[string]any{"counts": counts, "seen": seen})
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
