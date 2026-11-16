package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"io"
	"strings"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/pluginapi"
)

// Exercise the production SQL repository through database/sql, including a competing write
// that wins between the read and conditional update. No external database is needed in CI.
type todoSQLDriver struct {
	query func(string, []driver.NamedValue) (driver.Rows, error)
	exec  func(string, []driver.NamedValue) (driver.Result, error)
}

func (d *todoSQLDriver) Open(string) (driver.Conn, error) { return &todoSQLConn{d}, nil }

type todoSQLConnector struct{ d *todoSQLDriver }

func (c todoSQLConnector) Connect(context.Context) (driver.Conn, error) { return c.d.Open("") }
func (c todoSQLConnector) Driver() driver.Driver                        { return c.d }

type todoSQLConn struct{ d *todoSQLDriver }

func (c *todoSQLConn) Prepare(string) (driver.Stmt, error) { panic("unexpected prepare") }
func (c *todoSQLConn) Close() error                        { return nil }
func (c *todoSQLConn) Begin() (driver.Tx, error)           { panic("unexpected transaction") }
func (c *todoSQLConn) QueryContext(_ context.Context, q string, args []driver.NamedValue) (driver.Rows, error) {
	return c.d.query(q, args)
}
func (c *todoSQLConn) ExecContext(_ context.Context, q string, args []driver.NamedValue) (driver.Result, error) {
	return c.d.exec(q, args)
}

type todoSQLRows struct {
	columns []string
	data    [][]driver.Value
}

func (r *todoSQLRows) Columns() []string { return r.columns }
func (r *todoSQLRows) Close() error      { return nil }
func (r *todoSQLRows) Next(dest []driver.Value) error {
	if len(r.data) == 0 {
		return io.EOF
	}
	copy(dest, r.data[0])
	r.data = r.data[1:]
	return nil
}

type todoConfigAPI struct {
	todoAPI
	dialect string
}

func (a *todoConfigAPI) GetConfig() *model.Config {
	return &model.Config{SqlSettings: model.SqlSettings{DriverName: &a.dialect}}
}
func TestTodoSQLRepository(t *testing.T) {
	for _, dialect := range []string{"postgres", "mysql"} {
		t.Run(dialect, func(t *testing.T) {
			api := &todoConfigAPI{dialect: dialect}
			p := &Plugin{}
			p.client = pluginapi.NewClient(api, nil)
			d := &todoSQLDriver{}
			db := sql.OpenDB(todoSQLConnector{d})
			defer db.Close()
			repo := &sqlTodoRepository{db: db, p: p}
			task := todoItem{ID: scheduleFileID, ChannelID: scheduleChannelID, Text: "saved task", PostID: scheduleRootID, CreatorID: scheduleUserID, CreatedAt: 123, UpdatedAt: 123, Revision: 1}
			d.exec = func(q string, args []driver.NamedValue) (driver.Result, error) {
				if !strings.HasPrefix(q, "INSERT INTO tg_webui_todos") || len(args) != 9 || args[2].Value != task.Text || args[4].Value != int64(0) || args[8].Value != int64(1) {
					t.Fatalf("unexpected insert %s %+v", q, args)
				}
				if dialect == "postgres" && !strings.Contains(q, "$9") {
					t.Fatal("postgres placeholders missing")
				}
				return driver.RowsAffected(1), nil
			}
			if err := repo.Create(task); err != nil {
				t.Fatal(err)
			}
			row := func() driver.Rows {
				return &todoSQLRows{columns: strings.Split(todoColumns, ", "), data: [][]driver.Value{{task.ID, task.ChannelID, task.Text, task.PostID, int64(0), task.CreatorID, task.CreatedAt, task.UpdatedAt, task.Revision}}}
			}
			d.query = func(q string, args []driver.NamedValue) (driver.Rows, error) {
				if args[0].Value != task.ChannelID {
					t.Fatal("channel filter missing")
				}
				return row(), nil
			}
			// Listing through a fresh repository instance reads persisted data from the DB.
			fresh := &sqlTodoRepository{db: db, p: p}
			items, err := fresh.List(task.ChannelID)
			if err != nil || len(items) != 1 || items[0] != task {
				t.Fatalf("list: %+v %v", items, err)
			}
			d.query = func(q string, args []driver.NamedValue) (driver.Rows, error) {
				if !strings.Contains(q, "done = 0") || !strings.Contains(q, "GROUP BY channel_id") || len(args) != 2 {
					t.Fatal("incorrect aggregate", q)
				}
				return &todoSQLRows{columns: []string{"channel_id", "count"}, data: [][]driver.Value{{task.ChannelID, int64(1)}}}, nil
			}
			counts, err := repo.Counts([]string{task.ChannelID, scheduleRootID})
			if err != nil || counts[task.ChannelID] != 1 || counts[scheduleRootID] != 0 {
				t.Fatal(counts, err)
			}
			d.query = func(string, []driver.NamedValue) (driver.Rows, error) { return row(), nil }
			done := true
			d.exec = func(q string, args []driver.NamedValue) (driver.Result, error) {
				if !strings.Contains(q, "AND revision = ") || len(args) != 6 || args[0].Value != int64(1) || args[2].Value != int64(2) || args[5].Value != int64(1) {
					t.Fatal("unsafe completion", q, args)
				}
				return driver.RowsAffected(1), nil
			}
			changed, err := repo.Change(task.ChannelID, task.ID, 1, &done)
			if err != nil || !changed.Done || changed.Revision != 2 {
				t.Fatal(changed, err)
			}
			// Simulate another node changing the row after SELECT, before UPDATE/DELETE.
			d.exec = func(q string, args []driver.NamedValue) (driver.Result, error) {
				if !strings.Contains(q, "AND revision = ") {
					t.Fatal("revision guard missing", q)
				}
				return driver.RowsAffected(0), nil
			}
			if _, err := repo.Change(task.ChannelID, task.ID, 1, &done); err != errTodoConflict {
				t.Fatal("lost update not detected", err)
			}
			if _, err := repo.Change(task.ChannelID, task.ID, 1, nil); err != errTodoConflict {
				t.Fatal("stale delete not detected", err)
			}
			task.Revision = 2
			d.exec = func(string, []driver.NamedValue) (driver.Result, error) {
				t.Fatal("stale version attempted a write")
				return nil, nil
			}
			if _, err := repo.Change(task.ChannelID, task.ID, 1, &done); err != errTodoConflict {
				t.Fatal("stale revision not rejected", err)
			}
		})
	}
}
