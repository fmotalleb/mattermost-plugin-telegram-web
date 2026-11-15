package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

const testChannelID = "abcdefghijklmnopqrstuvwxyz"

type unmuteAPI struct {
	plugin.API
	roles         string
	channelType   model.ChannelType
	memberCount   int
	readFailure   bool
	failUser      string
	pages         []int
	updates       []string
	expectedProps map[string]string
	archived      bool
	deactivated   bool
	repeatPage    bool
}

func (a *unmuteAPI) GetUser(string) (*model.User, *model.AppError) {
	user := &model.User{Roles: a.roles}
	if a.deactivated {
		user.DeleteAt = 1
	}
	return user, nil
}
func (a *unmuteAPI) GetChannel(string) (*model.Channel, *model.AppError) {
	channel := &model.Channel{Id: testChannelID, Type: a.channelType}
	if a.archived {
		channel.DeleteAt = 1
	}
	return channel, nil
}
func (a *unmuteAPI) GetChannelMembers(channelID string, page, perPage int) (model.ChannelMembers, *model.AppError) {
	a.pages = append(a.pages, page)
	if a.readFailure && page == 1 {
		return nil, &model.AppError{}
	}
	if a.repeatPage {
		page = 0
	}
	var members model.ChannelMembers
	for i := page * perPage; i < (page+1)*perPage && i < a.memberCount; i++ {
		members = append(members, model.ChannelMember{UserId: fmt.Sprintf("member-%d", i)})
	}
	return members, nil
}
func (a *unmuteAPI) UpdateChannelMemberNotifications(channelID, userID string, props map[string]string) (*model.ChannelMember, *model.AppError) {
	expected := a.expectedProps
	if expected == nil {
		expected = map[string]string{"desktop": "default", "push": "default", "mark_unread": "all"}
	}
	if channelID != testChannelID || !reflect.DeepEqual(props, expected) {
		panic("unexpected notification patch")
	}
	a.updates = append(a.updates, userID)
	if userID == a.failUser {
		return nil, &model.AppError{}
	}
	return &model.ChannelMember{}, nil
}

func TestUnmuteChannel(t *testing.T) {
	for _, tc := range []struct {
		name, user, roles, body string
		channelType             model.ChannelType
		count                   int
		readFailure             bool
		failUser                string
		status, writes          int
		response                string
	}{
		{name: "anonymous", status: 401},
		{name: "ordinary member", user: "member", roles: "system_user", status: 403},
		{name: "channel admin", user: "member", roles: "system_user channel_admin", status: 403},
		{name: "invalid id", user: "admin", roles: "system_admin", body: `{"channel_id":"bad"}`, status: 400},
		{name: "direct message", user: "admin", roles: "system_admin", channelType: model.ChannelTypeDirect, status: 400},
		{name: "all pages", user: "admin", roles: "system_user system_admin", channelType: model.ChannelTypeOpen, count: 201, status: 200, writes: 201, response: `"updated":201`},
		{name: "private channel", user: "admin", roles: "system_admin", channelType: model.ChannelTypePrivate, count: 1, status: 200, writes: 1, response: `"failed":0`},
		{name: "read failure before writes", user: "admin", roles: "system_admin", channelType: model.ChannelTypeOpen, count: 201, readFailure: true, status: 500},
		{name: "partial failure continues", user: "admin", roles: "system_admin", channelType: model.ChannelTypeOpen, count: 3, failUser: "member-1", status: 200, writes: 3, response: `"failed":1,"updated":2`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api := &unmuteAPI{roles: tc.roles, channelType: tc.channelType, memberCount: tc.count, readFailure: tc.readFailure, failUser: tc.failUser}
			p := &Plugin{}
			p.SetAPI(api)
			body := tc.body
			if body == "" {
				body = `{"channel_id":"` + testChannelID + `"}`
			}
			r := httptest.NewRequest(http.MethodPost, unmuteChannelPath, strings.NewReader(body))
			r.Header.Set("Mattermost-User-Id", tc.user)
			w := httptest.NewRecorder()
			p.ServeHTTP(nil, w, r)
			if w.Code != tc.status || len(api.updates) != tc.writes || !strings.Contains(w.Body.String(), tc.response) {
				t.Fatalf("status=%d writes=%d body=%s", w.Code, len(api.updates), w.Body.String())
			}
			if tc.count == 201 && len(api.pages) != 2 {
				t.Fatalf("expected two pages, got %v", api.pages)
			}
		})
	}
}
