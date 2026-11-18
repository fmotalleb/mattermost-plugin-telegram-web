package main

import (
	"encoding/json"
	"io"
	"net/http"
)

// Bound parsing as well as the number of IDs we subsequently process. Require EOF
// so an ignored field or a second JSON value cannot evade the limit.
func decodeRequest(w http.ResponseWriter, r *http.Request, body any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384))
	if err := decoder.Decode(body); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err != nil {
			return err
		}
		return io.ErrUnexpectedEOF
	}
	return nil
}

// Bound simultaneous expensive RPC work without keeping attacker-controlled user
// IDs in a growing rate-limiter map.
func (p *Plugin) acquireWork(w http.ResponseWriter) bool {
	p.workMu.Lock()
	defer p.workMu.Unlock()
	if p.activeWork >= 4 {
		setResponseHeader(w, "Retry-After", "1")
		writeError(w, http.StatusTooManyRequests, "Too many active requests. Please retry.")
		return false
	}
	p.activeWork++
	return true
}
func (p *Plugin) releaseWork() {
	p.workMu.Lock()
	p.activeWork--
	p.workMu.Unlock()
}
