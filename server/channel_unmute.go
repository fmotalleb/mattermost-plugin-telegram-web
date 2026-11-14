package main

import (
	"encoding/json"
	"net/http"

	"github.com/mattermost/mattermost/server/public/model"
)

// Reset current members' mute settings through Mattermost so its normal member
// update events also refresh connected clients. This does not lock future settings.
func (p *Plugin) handleUnmuteChannel(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("Mattermost-User-Id")
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	user, appErr := p.API.GetUser(userID)
	if appErr != nil || user == nil || !user.IsSystemAdmin() {
		writeError(w, http.StatusForbidden, "system administrator required")
		return
	}
	var body struct {
		ChannelID string `json:"channel_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || !model.IsValidId(body.ChannelID) {
		writeError(w, http.StatusBadRequest, "valid channel_id required")
		return
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
	const pageSize = 200
	for page := 0; ; page++ {
		batch, err := p.API.GetChannelMembers(channel.Id, page, pageSize)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not load channel members; no settings changed")
			return
		}
		members = append(members, batch...)
		if len(batch) < pageSize {
			break
		}
	}
	updated, failed := 0, 0
	for _, member := range members {
		_, err := p.API.UpdateChannelMemberNotifications(channel.Id, member.UserId, map[string]string{
			"desktop": "default", "push": "default", "mark_unread": "all",
		})
		if err != nil {
			failed++
		} else {
			updated++
		}
	}
	writeJSON(w, map[string]int{"updated": updated, "failed": failed})
}
