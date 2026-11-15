package main

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/mattermost/mattermost/server/public/model"
)

// Reset current members' mute settings through Mattermost so its normal member
// update events also refresh connected clients. This does not lock future settings.
func (p *Plugin) handleUnmuteChannel(w http.ResponseWriter, r *http.Request) {
	p.handleChannelNotifications(w, r, true)
}

func (p *Plugin) handleOverrideChannelNotifications(w http.ResponseWriter, r *http.Request) {
	p.handleChannelNotifications(w, r, false)
}

// Both bulk actions share the same authorization, complete member loading and partial-failure
// reporting. Overrides are a one-time patch, not an enforced policy for future members.
func (p *Plugin) handleChannelNotifications(w http.ResponseWriter, r *http.Request, unmute bool) {
	userID := r.Header.Get("Mattermost-User-Id")
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	user, appErr := p.API.GetUser(userID)
	if appErr != nil || user == nil || user.DeleteAt != 0 || !user.IsSystemAdmin() {
		writeError(w, http.StatusForbidden, "system administrator required")
		return
	}
	var body struct {
		ChannelID   string            `json:"channel_id"`
		NotifyProps map[string]string `json:"notify_props"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	if err := decoder.Decode(&body); err != nil || !model.IsValidId(body.ChannelID) {
		writeError(w, http.StatusBadRequest, "valid channel_id required")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	props := body.NotifyProps
	if unmute {
		props = map[string]string{"desktop": "default", "push": "default", "mark_unread": "all"}
	} else {
		if len(props) == 0 {
			writeError(w, http.StatusBadRequest, "select at least one notification setting")
			return
		}
		for key := range props {
			switch key {
			case model.DesktopNotifyProp, model.PushNotifyProp, model.EmailNotifyProp, model.MarkUnreadNotifyProp, model.IgnoreChannelMentionsNotifyProp, model.ChannelAutoFollowThreads:
			default:
				writeError(w, http.StatusBadRequest, "unsupported notification setting")
				return
			}
		}
		if err := model.IsChannelMemberNotifyPropsValid(props, true); err != nil {
			writeError(w, http.StatusBadRequest, "invalid notification setting value")
			return
		}
	}
	channel, appErr := p.API.GetChannel(body.ChannelID)
	if appErr != nil || channel == nil || channel.DeleteAt != 0 {
		writeError(w, http.StatusNotFound, "channel not found")
		return
	}
	if channel.Type != model.ChannelTypeOpen && channel.Type != model.ChannelTypePrivate {
		writeError(w, http.StatusBadRequest, "only public and private channels are supported")
		return
	}
	// Load all pages before writing, so a read failure cannot cause a partial reset.
	var members model.ChannelMembers
	seen := make(map[string]bool)
	const pageSize = 200
	for page := 0; ; page++ {
		batch, err := p.API.GetChannelMembers(channel.Id, page, pageSize)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not load channel members; no settings changed")
			return
		}
		newMembers := 0
		for _, member := range batch {
			if !seen[member.UserId] {
				members = append(members, member)
				seen[member.UserId] = true
				newMembers++
			}
		}
		if len(batch) > 0 && newMembers == 0 {
			writeError(w, http.StatusInternalServerError, "channel member pages repeated; no settings changed")
			return
		}
		if len(batch) < pageSize {
			break
		}
	}
	updated, failed := 0, 0
	for _, member := range members {
		// Each call receives its own map so a host implementation cannot mutate the next patch.
		patch := make(map[string]string, len(props))
		for key, value := range props {
			patch[key] = value
		}
		_, err := p.API.UpdateChannelMemberNotifications(channel.Id, member.UserId, patch)
		if err != nil {
			failed++
		} else {
			updated++
		}
	}
	writeJSON(w, map[string]int{"updated": updated, "failed": failed})
}
