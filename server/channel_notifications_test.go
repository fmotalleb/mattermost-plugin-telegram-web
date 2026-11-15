package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
)

func TestOverrideChannelNotifications(t *testing.T) {
	all := map[string]string{"desktop": "all", "push": "mention", "email": "true", "mark_unread": "mention", "ignore_channel_mentions": "off", "channel_auto_follow_threads": "on"}
	for _, name := range []string{"anonymous", "member", "channel admin", "deactivated admin", "all settings", "one setting", "account defaults", "private channel", "DM", "GM", "archived", "empty patch", "unknown key", "invalid desktop", "invalid push", "invalid email", "invalid unread", "invalid mentions", "invalid follow", "read failure", "repeated page", "partial failure", "trailing JSON"} {
		t.Run(name, func(t *testing.T) {
			api := &unmuteAPI{roles: "system_user system_admin", channelType: model.ChannelTypeOpen, memberCount: 201, expectedProps: all}
			user := "admin"
			wantStatus, wantWrites := http.StatusOK, 201
			patch := all
			trailing := ""
			switch name {
			case "anonymous":
				user = ""
				wantStatus = 401
			case "member":
				api.roles = "system_user"
				wantStatus = 403
			case "channel admin":
				api.roles = "system_user channel_admin"
				wantStatus = 403
			case "deactivated admin":
				api.deactivated = true
				wantStatus = 403
			case "one setting":
				patch = map[string]string{"push": "none"}
				api.expectedProps = patch
			case "account defaults":
				patch = map[string]string{"desktop": "default", "push": "default", "email": "default", "ignore_channel_mentions": "default"}
				api.expectedProps = patch
			case "private channel":
				api.channelType = model.ChannelTypePrivate
			case "DM":
				api.channelType = model.ChannelTypeDirect
				wantStatus = 400
			case "GM":
				api.channelType = model.ChannelTypeGroup
				wantStatus = 400
			case "archived":
				api.archived = true
				wantStatus = 404
			case "empty patch":
				patch = map[string]string{}
				wantStatus = 400
			case "unknown key":
				patch = map[string]string{"desktop": "all", "roles": "system_admin"}
				wantStatus = 400
			case "invalid desktop":
				patch = map[string]string{"desktop": "invalid"}
				wantStatus = 400
			case "invalid push":
				patch = map[string]string{"push": "invalid"}
				wantStatus = 400
			case "invalid email":
				patch = map[string]string{"email": "all"}
				wantStatus = 400
			case "invalid unread":
				patch = map[string]string{"mark_unread": "default"}
				wantStatus = 400
			case "invalid mentions":
				patch = map[string]string{"ignore_channel_mentions": "true"}
				wantStatus = 400
			case "invalid follow":
				patch = map[string]string{"channel_auto_follow_threads": "default"}
				wantStatus = 400
			case "read failure":
				api.readFailure = true
				wantStatus = 500
			case "repeated page":
				api.repeatPage = true
				wantStatus = 500
			case "partial failure":
				api.failUser = "member-1"
			case "trailing JSON":
				trailing = "{}"
				wantStatus = 400
			}
			if wantStatus != 200 {
				wantWrites = 0
			}
			data, _ := json.Marshal(map[string]any{"channel_id": testChannelID, "notify_props": patch})
			request := httptest.NewRequest(http.MethodPost, overrideChannelNotificationsPath, strings.NewReader(string(data)+trailing))
			request.Header.Set("Mattermost-User-Id", user)
			response := httptest.NewRecorder()
			p := &Plugin{}
			p.SetAPI(api)
			p.ServeHTTP(nil, response, request)
			if response.Code != wantStatus || len(api.updates) != wantWrites {
				t.Fatalf("status=%d writes=%d body=%s", response.Code, len(api.updates), response.Body)
			}
			if wantStatus == 200 {
				var result map[string]int
				if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				failed := 0
				if api.failUser != "" {
					failed = 1
				}
				if result["updated"] != 201-failed || result["failed"] != failed {
					t.Fatalf("unexpected counts: %v", result)
				}
				if len(api.pages) != 2 {
					t.Fatalf("not all pages loaded: %v", api.pages)
				}
			}
		})
	}
}
