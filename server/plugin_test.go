package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Reproduce the Mattermost RPC writer when its Header call fails. Any further
// response writes are useless once that connection is unavailable.
type disconnectedResponseWriter struct{ testing *testing.T }

func (w disconnectedResponseWriter) Header() http.Header { return nil }
func (w disconnectedResponseWriter) Write([]byte) (int, error) {
	w.testing.Fatal("wrote body after headers became unavailable")
	return 0, nil
}
func (w disconnectedResponseWriter) WriteHeader(int) {
	w.testing.Fatal("wrote status after headers became unavailable")
}

func TestDisconnectedResponse(t *testing.T) {
	w := disconnectedResponseWriter{testing: t}
	writeJSON(w, map[string]int{"count": 1})
	writeError(w, http.StatusInternalServerError, "unavailable")

	for _, path := range []string{viewsPath, channelSearchPath, forwardPath, "/unknown"} {
		t.Run(path, func(t *testing.T) {
			p := &Plugin{}
			w := disconnectedResponseWriter{testing: t}
			// Exercise both Allow headers and authentication error responses.
			p.ServeHTTP(nil, w, httptest.NewRequest(http.MethodDelete, path, nil))
			p.ServeHTTP(nil, w, httptest.NewRequest(http.MethodPost, path, nil))
		})
	}
	// The empty stats response uses writeJSON without needing the database.
	r := httptest.NewRequest(http.MethodGet, viewsPath, nil)
	r.Header.Set("Mattermost-User-Id", "test-user")
	(&Plugin{}).ServeHTTP(nil, w, r)
}

func TestJSONResponses(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		write  func(http.ResponseWriter)
		key    string
		value  any
	}{
		{"success", http.StatusOK, func(w http.ResponseWriter) { writeJSON(w, map[string]int{"count": 1}) }, "count", float64(1)},
		{"error", http.StatusForbidden, func(w http.ResponseWriter) { writeError(w, http.StatusForbidden, "denied") }, "message", "denied"},
	} {
		t.Run(test.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			test.write(w)
			if w.Code != test.status || w.Header().Get("Content-Type") != "application/json" {
				t.Fatalf("unexpected response: status=%d headers=%v", w.Code, w.Header())
			}
			var body map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body[test.key] != test.value {
				t.Fatalf("unexpected body: %s (decode error: %v)", w.Body.String(), err)
			}
		})
	}
	for _, path := range []string{viewsPath, channelSearchPath, forwardPath} {
		w := httptest.NewRecorder()
		(&Plugin{}).ServeHTTP(nil, w, httptest.NewRequest(http.MethodDelete, path, nil))
		if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") == "" {
			t.Fatalf("missing method response for %s: status=%d headers=%v", path, w.Code, w.Header())
		}
	}
}
