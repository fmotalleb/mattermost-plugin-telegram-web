package main

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

type memoryTodos struct {
	mu    sync.Mutex
	tasks map[string]todoItem
	fail  bool
}

func (m *memoryTodos) List(channel string) ([]todoItem, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	items := []todoItem{}
	for _, v := range m.tasks {
		if v.ChannelID == channel {
			items = append(items, v)
		}
	}
	return items, nil
}
func (m *memoryTodos) Counts(channels []string) (map[string]int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := map[string]int{}
	for _, id := range channels {
		result[id] = 0
		for _, v := range m.tasks {
			if v.ChannelID == id && !v.Done {
				result[id]++
			}
		}
	}
	return result, nil
}
func (m *memoryTodos) Create(task todoItem) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.fail {
		return errors.New("storage unavailable")
	}
	m.tasks[task.ID] = task
	return nil
}
func (m *memoryTodos) Change(channel, id string, revision int64, done *bool) (*todoItem, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.tasks[id]
	if !ok || t.ChannelID != channel || t.Revision != revision {
		return nil, errTodoConflict
	}
	if done == nil {
		delete(m.tasks, id)
	} else {
		t.Done = *done
		t.Revision++
		m.tasks[id] = t
	}
	return &t, nil
}

type todoAPI struct {
	plugin.API
	denied, readonly, archived, foreign, deleted, postFailure bool
	posts                                                     []*model.Post
	broadcasts                                                []*model.WebsocketBroadcast
}

func (a *todoAPI) GetChannelMember(channel, user string) (*model.ChannelMember, *model.AppError) {
	if a.denied || channel == scheduleRootID {
		return nil, &model.AppError{StatusCode: 403}
	}
	return &model.ChannelMember{UserId: user, ChannelId: channel}, nil
}
func (a *todoAPI) GetChannel(id string) (*model.Channel, *model.AppError) {
	ch := &model.Channel{Id: id}
	if a.archived {
		ch.DeleteAt = 1
	}
	return ch, nil
}
func (a *todoAPI) HasPermissionToChannel(string, string, *model.Permission) bool { return !a.readonly }
func (a *todoAPI) GetPost(id string) (*model.Post, *model.AppError) {
	p := &model.Post{Id: id, ChannelId: scheduleChannelID}
	if a.foreign {
		p.ChannelId = scheduleRootID
	}
	if a.deleted {
		p.DeleteAt = 1
	}
	return p, nil
}
func (a *todoAPI) CreatePost(p *model.Post) (*model.Post, *model.AppError) {
	if a.postFailure {
		return nil, &model.AppError{StatusCode: 500}
	}
	a.posts = append(a.posts, p)
	return p, nil
}
func (a *todoAPI) PublishWebSocketEvent(_ string, _ map[string]any, b *model.WebsocketBroadcast) {
	a.broadcasts = append(a.broadcasts, b)
}
func (a *todoAPI) LogWarn(string, ...any) {}
func todoTestPlugin() (*Plugin, *todoAPI, *memoryTodos) {
	a := &todoAPI{}
	m := &memoryTodos{tasks: map[string]todoItem{}}
	return &Plugin{MattermostPlugin: plugin.MattermostPlugin{API: a}, todos: m}, a, m
}
func todoRequest(p *Plugin, method, path, body, user string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if user != "" {
		r.Header.Set("Mattermost-User-Id", user)
	}
	w := httptest.NewRecorder()
	p.ServeHTTP(nil, w, r)
	return w
}
func TestSharedTodos(t *testing.T) {
	p, a, repo := todoTestPlugin()
	base := todoPath + "?channel_id=" + scheduleChannelID
	w := todoRequest(p, "POST", base, `{"text":"Shared task"}`, scheduleUserID)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var result struct {
		Task               todoItem `json:"task"`
		NotificationFailed bool     `json:"notification_failed"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	task := result.Task
	if task.CreatorID != scheduleUserID || task.Revision != 1 || len(a.posts) != 1 || a.posts[0].UserId != scheduleUserID || a.broadcasts[0].ChannelId != scheduleChannelID {
		t.Fatalf("bad create: %+v", result)
	}
	w = todoRequest(p, "GET", base, "", scheduleFileID)
	if !strings.Contains(w.Body.String(), "Shared task") {
		t.Fatal(w.Body.String())
	}
	item := todoPath + "/" + task.ID + "?channel_id=" + scheduleChannelID
	for _, step := range []struct{ done, revision, count string }{{"true", "1", `:0`}, {"false", "2", `:1`}} {
		w = todoRequest(p, "PATCH", item, `{"done":`+step.done+`,"revision":`+step.revision+`}`, scheduleFileID)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		counts := todoRequest(p, "GET", todoPath+"/counts?channel_ids="+scheduleChannelID+","+scheduleRootID, "", scheduleFileID)
		if !strings.Contains(counts.Body.String(), step.count) || strings.Contains(counts.Body.String(), scheduleRootID) {
			t.Fatal(counts.Body.String())
		}
	}
	w = todoRequest(p, "DELETE", item, `{"revision":1}`, scheduleUserID)
	if w.Code != 409 {
		t.Fatal("stale delete", w.Code)
	}
	w = todoRequest(p, "DELETE", item, `{"revision":3}`, scheduleFileID)
	if w.Code != 200 || len(repo.tasks) != 0 || len(a.posts) != 4 {
		t.Fatal("delete failed", w.Code, len(a.posts))
	}
}
func TestTodoValidationAndPermissions(t *testing.T) {
	for _, tc := range []struct {
		name, method, path, body, user string
		status                         int
		setup                          func(*todoAPI)
	}{
		{"authentication", "GET", todoPath, "", "", 401, nil},
		{"outsider", "GET", todoPath + "?channel_id=" + scheduleChannelID, "", scheduleUserID, 403, func(a *todoAPI) { a.denied = true }},
		{"readonly", "POST", todoPath + "?channel_id=" + scheduleChannelID, `{"text":"x"}`, scheduleUserID, 403, func(a *todoAPI) { a.readonly = true }},
		{"archived", "POST", todoPath + "?channel_id=" + scheduleChannelID, `{"text":"x"}`, scheduleUserID, 403, func(a *todoAPI) { a.archived = true }},
		{"blank", "POST", todoPath + "?channel_id=" + scheduleChannelID, `{"text":"  "}`, scheduleUserID, 400, nil},
		{"long", "POST", todoPath + "?channel_id=" + scheduleChannelID, `{"text":"` + strings.Repeat("x", 4001) + `"}`, scheduleUserID, 400, nil},
		{"foreign link", "POST", todoPath + "?channel_id=" + scheduleChannelID, `{"post_id":"` + scheduleRootID + `"}`, scheduleUserID, 400, func(a *todoAPI) { a.foreign = true }},
		{"deleted link", "POST", todoPath + "?channel_id=" + scheduleChannelID, `{"post_id":"` + scheduleRootID + `"}`, scheduleUserID, 400, func(a *todoAPI) { a.deleted = true }},
		{"two bodies", "POST", todoPath + "?channel_id=" + scheduleChannelID, `{"text":"x"} {}`, scheduleUserID, 400, nil},
		{"method", "PUT", todoPath, "", scheduleUserID, 405, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, a, _ := todoTestPlugin()
			if tc.setup != nil {
				tc.setup(a)
			}
			w := todoRequest(p, tc.method, tc.path, tc.body, tc.user)
			if w.Code != tc.status || len(a.posts) != 0 || len(a.broadcasts) != 0 {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
	p, a, repo := todoTestPlugin()
	a.postFailure = true
	w := todoRequest(p, "POST", todoPath+"?channel_id="+scheduleChannelID, `{"post_id":"`+scheduleRootID+`"}`, scheduleUserID)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"notification_failed":true`) || len(repo.tasks) != 1 {
		t.Fatal(w.Body.String())
	}
	a.postFailure = false
	repo.fail = true
	w = todoRequest(p, "POST", todoPath+"?channel_id="+scheduleChannelID, `{"text":"x"}`, scheduleUserID)
	if w.Code != 500 || len(a.broadcasts) != 1 || len(a.posts) != 0 {
		t.Fatal("storage failure emitted activity")
	}
}
func TestTodoActivityEscaping(t *testing.T) {
	got := todoActivityLabel("hello\n@all `code` **bold**")
	if got != "`` hello @all `code` **bold** ``" {
		t.Fatal(got)
	}
}
