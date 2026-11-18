package main

import (
	"context"
	"encoding/json"
	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type searchSecurityAPI struct {
	*schedulingAPI
	beforeReads   int
	foreignCursor bool
}

func (a *searchSecurityAPI) GetPost(id string) (*model.Post, *model.AppError) {
	for _, post := range a.history {
		if post.Id == id {
			copy := post.Clone()
			if a.foreignCursor {
				copy.ChannelId = model.NewId()
			}
			return copy, nil
		}
	}
	return nil, &model.AppError{StatusCode: 404}
}
func (a *searchSecurityAPI) GetPostsBefore(channel, before string, page, count int) (*model.PostList, *model.AppError) {
	a.beforeReads++
	list := model.NewPostList()
	for i, post := range a.history {
		if post.Id == before {
			for _, p := range a.history[i+1 : min(i+1+count, len(a.history))] {
				list.AddPost(p)
				list.AddOrder(p.Id)
			}
			break
		}
	}
	return list, nil
}
func searchSecurityPlugin(count int) (*Plugin, *searchSecurityAPI) {
	_, base := scheduleTestPlugin()
	a := &searchSecurityAPI{schedulingAPI: base}
	for i := 0; i < count; i++ {
		a.history = append(a.history, &model.Post{Id: model.NewId(), ChannelId: scheduleChannelID, Message: "match", CreateAt: int64(count - i)})
	}
	return &Plugin{MattermostPlugin: plugin.MattermostPlugin{API: a}}, a
}
func searchRequest(p *Plugin, before string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"channel_id": scheduleChannelID, "term": "match", "before": before})
	r := httptest.NewRequest(http.MethodPost, channelSearchPath, strings.NewReader(string(body)))
	r.Header.Set("Mattermost-User-Id", scheduleUserID)
	w := httptest.NewRecorder()
	p.ServeHTTP(nil, w, r)
	return w
}
func TestSearchBudgetAndCursor(t *testing.T) {
	p, a := searchSecurityPlugin(3*channelSearchPageSize + 3)
	before := ""
	seen := map[string]bool{}
	for page := 0; page < 4; page++ {
		w := searchRequest(p, before)
		var result struct {
			Order []string `json:"order"`
			Next  string   `json:"next_before"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
			t.Fatalf("response: %d %s", w.Code, w.Body)
		}
		if len(result.Order) > channelSearchPageSize {
			t.Fatal("unbounded result")
		}
		for _, id := range result.Order {
			if seen[id] {
				t.Fatal("duplicate result")
			}
			seen[id] = true
		}
		before = result.Next
	}
	if before != "" || len(seen) != len(a.history) || a.historyReads != 1 || a.beforeReads != 3 {
		t.Fatalf("pagination lost results: next=%q found=%d reads=%d/%d", before, len(seen), a.historyReads, a.beforeReads)
	}
	a.foreignCursor = true
	w := searchRequest(p, a.history[0].Id)
	if w.Code != 400 || a.beforeReads != 3 {
		t.Fatal("foreign cursor was accepted")
	}
}
func TestSearchCancellationAndConcurrency(t *testing.T) {
	p, a := searchSecurityPlugin(500)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest(http.MethodPost, channelSearchPath, strings.NewReader(`{}`)).WithContext(ctx)
	r.Header.Set("Mattermost-User-Id", scheduleUserID)
	p.ServeHTTP(nil, httptest.NewRecorder(), r)
	if a.historyReads != 0 {
		t.Fatal("cancelled request loaded history")
	}
	p.activeWork = 4
	if w := searchRequest(p, ""); w.Code != 429 || a.historyReads != 0 {
		t.Fatal("concurrency limit not enforced")
	}
}
func TestSearchResponseByteBudget(t *testing.T) {
	p, a := searchSecurityPlugin(channelSearchPageSize)
	for _, post := range a.history {
		post.Message = "match" + strings.Repeat("x", 100000)
	}
	w := searchRequest(p, "")
	var result struct {
		Next string `json:"next_before"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	if w.Code != 200 || w.Body.Len() > 1024*1024+4096 || result.Next == "" {
		t.Fatalf("response budget or continuation: status=%d size=%d", w.Code, w.Body.Len())
	}
}
func TestLimitedRequestBodies(t *testing.T) {
	for _, path := range []string{viewsPath, channelSearchPath, forwardPath} {
		for _, body := range []string{`{"ignored":"` + strings.Repeat("x", 2*1024*1024) + `"}`, `{} {}`} {
			r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
			r.Header.Set("Mattermost-User-Id", scheduleUserID)
			w := httptest.NewRecorder()
			(&Plugin{}).ServeHTTP(nil, w, r)
			if w.Code != 400 {
				t.Fatalf("%s accepted oversized or trailing body: %d", path, w.Code)
			}
		}
	}
}
func TestClusterScheduleAdmissionQuota(t *testing.T) {
	p, a := scheduleTestPlugin()
	for i := 0; i < maxScheduledPerUser-1; i++ {
		if err := p.saveScheduledPost(&scheduledPost{ID: model.NewId(), UserID: scheduleUserID}); err != nil {
			t.Fatal(err)
		}
	}
	other := &Plugin{MattermostPlugin: plugin.MattermostPlugin{API: a}}
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for _, instance := range []*Plugin{p, other} {
		wg.Add(1)
		go func(instance *Plugin) {
			defer wg.Done()
			statuses <- postSchedule(instance, validScheduleBody(), scheduleUserID).Code
		}(instance)
	}
	wg.Wait()
	close(statuses)
	got := map[int]int{}
	for status := range statuses {
		got[status]++
	}
	if got[201] != 1 || got[429] != 1 || len(a.data) != maxScheduledPerUser {
		t.Fatalf("cluster quota race: statuses=%v records=%d", got, len(a.data))
	}
}
func TestGlobalScheduleBudgets(t *testing.T) {
	for _, kind := range []string{"count", "bytes"} {
		t.Run(kind, func(t *testing.T) {
			p, a := scheduleTestPlugin()
			count := maxScheduledTotal
			message := "x"
			if kind == "bytes" {
				count = 300
				message = strings.Repeat("x", 60000)
			}
			for i := 0; i < count; i++ {
				if err := p.saveScheduledPost(&scheduledPost{ID: model.NewId(), UserID: model.NewId(), Message: message}); err != nil {
					t.Fatal(err)
				}
			}
			if w := postSchedule(p, validScheduleBody(), scheduleUserID); w.Code != 429 || len(a.data) != count {
				t.Fatalf("%s quota: status=%d records=%d", kind, w.Code, len(a.data))
			}
		})
	}
}
func TestScheduleScanBoundAndListCache(t *testing.T) {
	p, a := scheduleTestPlugin()
	for i := 0; i < maxScheduleScanKeys; i++ {
		a.data[model.NewId()] = []byte("ignored")
	}
	if _, err := p.scheduledPosts(); err == nil {
		t.Fatal("unbounded KV scan")
	}
	p, a = scheduleTestPlugin()
	_ = p.saveScheduledPost(&scheduledPost{ID: model.NewId(), UserID: scheduleUserID})
	first, err := p.cachedScheduledPosts(context.Background())
	if err != nil || len(first) != 1 {
		t.Fatal("cache load failed")
	}
	a.failRead = true
	second, err := p.cachedScheduledPosts(context.Background())
	if err != nil || len(second) != 1 {
		t.Fatal("list rescanned despite fresh cache")
	}
	p.invalidateScheduledList()
	if _, err := p.cachedScheduledPosts(context.Background()); err == nil {
		t.Fatal("invalidation did not reread storage")
	}
}

func TestScheduleRemovalUsesQueueLock(t *testing.T) {
	p, a := scheduleTestPlugin()
	post := &scheduledPost{ID: model.NewId(), UserID: scheduleUserID, Message: "pending"}
	if err := p.saveScheduledPost(post); err != nil {
		t.Fatal(err)
	}
	lock, err := p.lockScheduleQueue(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	r := httptest.NewRequest(http.MethodDelete, schedulePath+"/"+post.ID, nil).WithContext(ctx)
	r.Header.Set("Mattermost-User-Id", scheduleUserID)
	w := httptest.NewRecorder()
	p.ServeHTTP(nil, w, r)
	cancel()
	lock.Unlock()
	if w.Code != 500 || a.data[scheduleKeyPrefix+post.ID] == nil {
		t.Fatal("cancellation bypassed a concurrent admission scan")
	}
	r = httptest.NewRequest(http.MethodDelete, schedulePath+"/"+post.ID, nil)
	r.Header.Set("Mattermost-User-Id", scheduleUserID)
	w = httptest.NewRecorder()
	p.ServeHTTP(nil, w, r)
	if w.Code != 200 || len(a.data) != 0 {
		t.Fatal("cancellation failed after queue lock released")
	}
}

func TestDeliveryReconciliationWorkBudget(t *testing.T) {
	p, a := scheduleTestPlugin()
	now := model.GetMillis()
	job := &scheduledPost{ID: model.NewId(), ChannelID: scheduleChannelID, UserID: scheduleUserID, StartedAt: now}
	for i := 0; i < maxReconciliationPages*100+1; i++ {
		a.history = append(a.history, &model.Post{Id: model.NewId(), CreateAt: now, UserId: scheduleUserID})
	}
	if delivered, err := p.scheduledPostDelivered(job); delivered || err == nil || a.historyReads != maxReconciliationPages {
		t.Fatal("reconciliation exceeded its budget or mistook a partial scan for proof of non-delivery")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	reads := a.historyReads
	if _, err := p.scheduledPostDeliveredContext(ctx, job); err == nil || reads != a.historyReads {
		t.Fatal("cancelled reconciliation continued scanning")
	}
}
