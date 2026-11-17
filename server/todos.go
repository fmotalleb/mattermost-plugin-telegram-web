package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/mattermost/mattermost/server/public/model"
)

const todoPath = "/api/v1/todos"
const todoEvent = "todos_changed"

var errTodoConflict = errors.New("This task changed. Refresh and try again.")

type todoItem struct {
	ID        string `json:"id"`
	ChannelID string `json:"channel_id"`
	Text      string `json:"text"`
	PostID    string `json:"post_id,omitempty"`
	Done      bool   `json:"done"`
	CreatorID string `json:"creator_id"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
	Revision  int64  `json:"revision"`
}

type todoRepository interface {
	List(string) ([]todoItem, error)
	Counts([]string) (map[string]int, error)
	Create(todoItem) error
	Change(string, string, int64, *bool, *string) (*todoItem, error)
}

type sqlTodoRepository struct {
	db *sql.DB
	p  *Plugin
}

func (p *Plugin) ensureTodoTable() error {
	db, err := p.client.Store.GetMasterDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS tg_webui_todos (
 id VARCHAR(26) PRIMARY KEY, channel_id VARCHAR(26) NOT NULL, task_text TEXT NOT NULL,
 post_id VARCHAR(26) NOT NULL, done SMALLINT NOT NULL, creator_id VARCHAR(26) NOT NULL,
 created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, revision BIGINT NOT NULL)`)
	if err != nil {
		return err
	}
	p.createIndex(db, `CREATE INDEX IF NOT EXISTS tg_webui_todos_channel ON tg_webui_todos (channel_id, done)`)
	p.todos = &sqlTodoRepository{db: db, p: p}
	return nil
}

const todoColumns = "id, channel_id, task_text, post_id, done, creator_id, created_at, updated_at, revision"

func scanTodo(row interface{ Scan(...any) error }) (*todoItem, error) {
	t := &todoItem{}
	var done int
	err := row.Scan(&t.ID, &t.ChannelID, &t.Text, &t.PostID, &done, &t.CreatorID, &t.CreatedAt, &t.UpdatedAt, &t.Revision)
	t.Done = done != 0
	return t, err
}
func (s *sqlTodoRepository) List(channel string) ([]todoItem, error) {
	rows, err := s.db.Query("SELECT "+todoColumns+" FROM tg_webui_todos WHERE channel_id = "+s.p.ph(1)+" ORDER BY done, created_at DESC, id", channel)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []todoItem{}
	for rows.Next() {
		t, err := scanTodo(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *t)
	}
	return items, rows.Err()
}
func (s *sqlTodoRepository) Counts(channels []string) (map[string]int, error) {
	counts := map[string]int{}
	if len(channels) == 0 {
		return counts, nil
	}
	args := make([]any, len(channels))
	for i, id := range channels {
		args[i] = id
		counts[id] = 0
	}
	rows, err := s.db.Query("SELECT channel_id, COUNT(*) FROM tg_webui_todos WHERE done = 0 AND channel_id IN "+s.p.inPlaceholders(1, len(args))+" GROUP BY channel_id", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		counts[id] = n
	}
	return counts, rows.Err()
}
func (s *sqlTodoRepository) Create(t todoItem) error {
	_, err := s.db.Exec("INSERT INTO tg_webui_todos ("+todoColumns+") VALUES "+s.p.inPlaceholders(1, 9), t.ID, t.ChannelID, t.Text, t.PostID, 0, t.CreatorID, t.CreatedAt, t.UpdatedAt, t.Revision)
	return err
}

// The revision condition makes completion, renaming and deletion compete on the same row across nodes.
func (s *sqlTodoRepository) Change(channel, id string, revision int64, done *bool, text *string) (*todoItem, error) {
	t, err := scanTodo(s.db.QueryRow("SELECT "+todoColumns+" FROM tg_webui_todos WHERE channel_id = "+s.p.ph(1)+" AND id = "+s.p.ph(2), channel, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errTodoConflict
	}
	if err != nil {
		return nil, err
	}
	if t.Revision != revision {
		return nil, errTodoConflict
	}
	var result sql.Result
	if done == nil && text == nil {
		result, err = s.db.Exec("DELETE FROM tg_webui_todos WHERE channel_id = "+s.p.ph(1)+" AND id = "+s.p.ph(2)+" AND revision = "+s.p.ph(3), channel, id, revision)
	} else {
		if done != nil {
			t.Done = *done
		}
		if text != nil {
			t.Text = *text
		}
		n := 0
		if t.Done {
			n = 1
		}
		t.UpdatedAt = model.GetMillis()
		t.Revision++
		result, err = s.db.Exec("UPDATE tg_webui_todos SET done = "+s.p.ph(1)+", task_text = "+s.p.ph(2)+", updated_at = "+s.p.ph(3)+", revision = "+s.p.ph(4)+" WHERE channel_id = "+s.p.ph(5)+" AND id = "+s.p.ph(6)+" AND revision = "+s.p.ph(7), n, t.Text, t.UpdatedAt, t.Revision, channel, id, revision)
	}
	if err != nil {
		return nil, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, errTodoConflict
	}
	return t, nil
}

func (p *Plugin) todoAccess(user, channel string, write bool) bool {
	if !model.IsValidId(channel) {
		return false
	}
	member, err := p.API.GetChannelMember(channel, user)
	if err != nil || member == nil {
		return false
	}
	if !write {
		return true
	}
	ch, err := p.API.GetChannel(channel)
	return err == nil && ch != nil && ch.DeleteAt == 0 && p.API.HasPermissionToChannel(user, channel, model.PermissionCreatePost)
}

func (p *Plugin) handleTodos(w http.ResponseWriter, r *http.Request) {
	user := r.Header.Get("Mattermost-User-Id")
	if user == "" {
		writeError(w, 401, "authentication required")
		return
	}
	channel := r.URL.Query().Get("channel_id")
	if r.Method == http.MethodGet && strings.HasSuffix(strings.TrimSuffix(r.URL.Path, "/"), "/counts") {
		ids := strings.Split(r.URL.Query().Get("channel_ids"), ",")
		if len(ids) > 100 {
			writeError(w, 400, "at most 100 channels are allowed")
			return
		}
		allowed := []string{}
		seen := map[string]bool{}
		for _, id := range ids {
			if !seen[id] && p.todoAccess(user, id, false) {
				allowed = append(allowed, id)
				seen[id] = true
			}
		}
		counts, err := p.todos.Counts(allowed)
		if err != nil {
			writeError(w, 500, "could not load todo counts")
			return
		}
		writeJSON(w, counts)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost && r.Method != http.MethodPatch && r.Method != http.MethodDelete {
		setResponseHeader(w, "Allow", "GET, POST, PATCH, DELETE")
		writeError(w, 405, "method not allowed")
		return
	}
	if !p.todoAccess(user, channel, r.Method != http.MethodGet) {
		writeError(w, 403, "channel membership and posting permission are required for changes")
		return
	}
	path := strings.TrimSuffix(r.URL.Path, "/")
	tail := path[strings.Index(path, todoPath)+len(todoPath):]
	if r.Method == http.MethodGet {
		if tail != "" {
			writeError(w, 404, "not found")
			return
		}
		items, err := p.todos.List(channel)
		if err != nil {
			writeError(w, 500, "could not load todos")
			return
		}
		writeJSON(w, items)
		return
	}
	var body struct {
		Text     *string `json:"text"`
		PostID   string  `json:"post_id"`
		Done     *bool   `json:"done"`
		Revision int64   `json:"revision"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32768))
	if err := decoder.Decode(&body); err != nil {
		writeError(w, 400, "invalid todo body")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, 400, "invalid JSON body")
		return
	}
	var task *todoItem
	var err error
	action := "added"
	if r.Method == http.MethodPost {
		if tail != "" {
			writeError(w, 404, "not found")
			return
		}
		text := ""
		if body.Text != nil {
			text = strings.TrimSpace(*body.Text)
		}
		if utf8.RuneCountInString(text) > 4000 || (text == "" && body.PostID == "") {
			writeError(w, 400, "text (up to 4000 characters) or a linked message is required")
			return
		}
		if body.PostID != "" {
			if !model.IsValidId(body.PostID) {
				writeError(w, 400, "invalid linked message")
				return
			}
			post, appErr := p.API.GetPost(body.PostID)
			if appErr != nil || post == nil || post.DeleteAt != 0 || post.ChannelId != channel {
				writeError(w, 400, "linked message must exist in this chat")
				return
			}
		}
		now := model.GetMillis()
		task = &todoItem{ID: model.NewId(), ChannelID: channel, Text: text, PostID: body.PostID, CreatorID: user, CreatedAt: now, UpdatedAt: now, Revision: 1}
		err = p.todos.Create(*task)
	} else {
		id := strings.TrimPrefix(tail, "/")
		if !strings.HasPrefix(tail, "/") || !model.IsValidId(id) || body.Revision < 1 || (r.Method == http.MethodPatch && body.Done == nil && body.Text == nil) {
			writeError(w, 400, "task ID, revision and a label or completion state are required")
			return
		}
		if r.Method == http.MethodPatch && body.Text != nil {
			text := strings.TrimSpace(*body.Text)
			if text == "" || utf8.RuneCountInString(text) > 4000 {
				writeError(w, 400, "a label of up to 4000 characters is required")
				return
			}
			body.Text = &text
		}
		done, text := body.Done, body.Text
		if r.Method == http.MethodDelete {
			done, text = nil, nil
			action = "removed"
		} else if text != nil {
			action = "renamed"
		} else if *done {
			action = "completed"
		} else {
			action = "reopened"
		}
		task, err = p.todos.Change(channel, id, body.Revision, done, text)
	}
	if errors.Is(err, errTodoConflict) {
		writeError(w, 409, err.Error())
		return
	}
	if err != nil {
		writeError(w, 500, "could not save todo")
		return
	}
	// Events carry only an invalidation, never another channel's task contents.
	p.API.PublishWebSocketEvent(todoEvent, map[string]any{"channel_id": channel}, &model.WebsocketBroadcast{ChannelId: channel})
	label := task.Text
	if label == "" {
		label = "Linked todo"
	}
	// A code span with a delimiter longer than any run in the text prevents mentions and markdown.
	safe := todoActivityLabel(label)
	_, appErr := p.API.CreatePost(&model.Post{UserId: user, ChannelId: channel, Message: "TODO · " + action + ": " + safe, Props: model.StringInterface{"tgw_todo_id": task.ID, "tgw_todo_action": action}})
	if appErr != nil {
		p.API.LogWarn("todo saved but activity message failed", "todo_id", task.ID, "error", appErr.Error())
	}
	writeJSON(w, map[string]any{"task": task, "notification_failed": appErr != nil})
}

func todoActivityLabel(label string) string {
	label = strings.Join(strings.Fields(label), " ")
	longest, run := 0, 0
	for _, r := range label {
		if r == '`' {
			run++
			if run > longest {
				longest = run
			}
		} else {
			run = 0
		}
	}
	fence := strings.Repeat("`", longest+1)
	return fence + " " + label + " " + fence
}
