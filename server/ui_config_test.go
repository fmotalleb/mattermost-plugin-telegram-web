package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

type uiConfigAPI struct {
	plugin.API
	enabled bool
	fail    bool
	events  int
}

func (a *uiConfigAPI) LoadPluginConfiguration(dest any) error {
	if a.fail {
		return errors.New("unavailable")
	}
	// Exercise the same JSON field matching used by Mattermost's configuration loader.
	data := `{"UseAppleEmoji":false}`
	if a.enabled {
		data = `{"UseAppleEmoji":true}`
	}
	return json.Unmarshal([]byte(data), dest)
}
func (a *uiConfigAPI) PublishWebSocketEvent(event string, _ map[string]any, _ *model.WebsocketBroadcast) {
	if event == uiConfigChangedEvent {
		a.events++
	}
}

func TestUIConfig(t *testing.T) {
	api := &uiConfigAPI{}
	p := &Plugin{MattermostPlugin: plugin.MattermostPlugin{API: api}}
	request := func(method string, authenticated bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, uiConfigPath, nil)
		if authenticated {
			r.Header.Set("Mattermost-User-Id", "user")
		}
		w := httptest.NewRecorder()
		p.ServeHTTP(nil, w, r)
		return w
	}
	if w := request(http.MethodGet, false); w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated: %d", w.Code)
	}
	if w := request(http.MethodPost, true); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("method: %d", w.Code)
	}
	if w := request(http.MethodGet, true); w.Code != 200 || w.Body.String() != "{\"appleEmoji\":false}\n" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("default: %d %s", w.Code, w.Body)
	}
	api.enabled = true
	if err := p.OnConfigurationChange(); err != nil || api.events != 1 {
		t.Fatalf("configuration event: %v, %d", err, api.events)
	}
	if w := request(http.MethodGet, true); w.Code != 200 || w.Body.String() != "{\"appleEmoji\":true}\n" {
		t.Fatalf("enabled: %d %s", w.Code, w.Body)
	}
	api.fail = true
	if w := request(http.MethodGet, true); w.Code != http.StatusInternalServerError {
		t.Fatalf("failure: %d", w.Code)
	}
}
