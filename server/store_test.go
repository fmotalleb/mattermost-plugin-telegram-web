package main

import (
	"database/sql/driver"
	"slices"
	"strings"
	"testing"

	"github.com/mattermost/mattermost/server/public/plugin"
	"github.com/mattermost/mattermost/server/public/pluginapi"
)

type viewStoreDriver struct {
	plugin.Driver
	exec func(string, []driver.NamedValue) (plugin.ResultContainer, error)
}

func (*viewStoreDriver) Conn(bool) (string, error) { return "master", nil }
func (*viewStoreDriver) ConnPing(string) error     { return nil }
func (*viewStoreDriver) ConnClose(string) error    { return nil }
func (d *viewStoreDriver) ConnExec(_ string, query string, args []driver.NamedValue) (plugin.ResultContainer, error) {
	return d.exec(query, args)
}

func TestRecordViewUsesAtomicUpsert(t *testing.T) {
	const viewedAt int64 = 123
	for _, tc := range []struct {
		dialect string
		clause  string
		args    []driver.Value
	}{
		{
			dialect: "postgres",
			clause: `VALUES ($1, $2, $3, $4)
				ON CONFLICT (user_id, post_id) DO UPDATE
				SET viewed_at = GREATEST(tg_webui_user_view_tracking.viewed_at, EXCLUDED.viewed_at)`,
			args: []driver.Value{"user", "post", "channel", viewedAt},
		},
		{
			dialect: "mysql",
			clause: `VALUES (?, ?, ?, ?)
				ON DUPLICATE KEY UPDATE viewed_at = GREATEST(viewed_at, ?)`,
			args: []driver.Value{"user", "post", "channel", viewedAt, viewedAt},
		},
	} {
		t.Run(tc.dialect, func(t *testing.T) {
			calls := 0
			d := &viewStoreDriver{exec: func(query string, args []driver.NamedValue) (plugin.ResultContainer, error) {
				calls++
				want := "INSERT INTO tg_webui_user_view_tracking (user_id, post_id, channel_id, viewed_at) " + tc.clause
				if !slices.Equal(strings.Fields(query), strings.Fields(want)) {
					t.Fatalf("expected a single upsert, got %s", query)
				}
				values := make([]driver.Value, len(args))
				for i, arg := range args {
					values[i] = arg.Value
				}
				if !slices.Equal(values, tc.args) {
					t.Fatalf("upsert args = %v, want %v", values, tc.args)
				}
				// MySQL may report zero rows affected for an unchanged timestamp.
				return plugin.ResultContainer{}, nil
			}}
			p := &Plugin{client: pluginapi.NewClient(&todoConfigAPI{dialect: tc.dialect}, d)}
			t.Cleanup(func() { _ = p.client.Store.Close() })
			if err := p.recordView("user", "post", "channel", viewedAt); err != nil {
				t.Fatal(err)
			}
			if calls != 1 {
				t.Fatalf("recordView executed %d statements, want 1", calls)
			}
		})
	}
}
