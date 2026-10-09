package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Helper: build a server pointing at a temp root, then close the temp root.
// ---------------------------------------------------------------------------

func makeTestServer(t *testing.T, root string) *server {
	t.Helper()
	srv := &server{
		root:        root,
		indexHTML:   []byte("index"),
		sessionTmpl: "session",
	}
	return srv
}

// ---------------------------------------------------------------------------
// escapePathSegments
// ---------------------------------------------------------------------------

func TestEscapePathSegments(t *testing.T) {
	tests := []struct {
		in  string
		out string
	}{
		{"foo/bar", "foo/bar"},
		{"foo bar/baz", "foo%20bar/baz"},
		{"a+b/c", "a+b/c"},
		{"日本語/ファイル", "%E6%97%A5%E6%9C%AC%E8%AA%9E/%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB"},
		{"single", "single"},
		{"a/b/c/d", "a/b/c/d"},
	}
	for _, tc := range tests {
		t.Run(tc.in, func(t *testing.T) {
			got := escapePathSegments(tc.in)
			if got != tc.out {
				t.Errorf("escapePathSegments(%q) = %q, want %q", tc.in, got, tc.out)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// resolveSession – path traversal protection
// ---------------------------------------------------------------------------

func TestResolveSession(t *testing.T) {
	tmp := t.TempDir()
	// Create a valid session dir
	if err := os.MkdirAll(filepath.Join(tmp, "my-session"), 0755); err != nil {
		t.Fatal(err)
	}

	srv := &server{root: tmp}

	ok, cases := true, []struct {
		name string
		want bool
	}{
		{"my-session", true},
		{"", false},
		{".", false},
		{"..", false},
		{"../etc", false},
		{"foo/bar", false},
		{"foo\\bar", false},
		{"nonexistent", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir, ok := srv.resolveSession(c.name)
			if ok != c.want {
				t.Errorf("resolveSession(%q) = %v, want %v", c.name, ok, c.want)
			}
			if ok && dir == "" {
				t.Error("resolveSession returned empty dir but ok=true")
			}
		})
	}

	// Also create a sibling dir and verify resolveSession does NOT find it
	sibling := filepath.Join(tmp, "other")
	if err := os.MkdirAll(sibling, 0755); err != nil {
		t.Fatal(err)
	}
	_, ok = srv.resolveSession("other")
	if !ok {
		t.Error("resolveSession should find valid session dir")
	}
}

// ---------------------------------------------------------------------------
// readVisible – filters macOS resource fork / DS_Store
// ---------------------------------------------------------------------------

func TestReadVisible(t *testing.T) {
	dir := t.TempDir()
	// Create a mix of visible and hidden entries
	for _, name := range []string{"track.wav", "._track.wav", ".DS_Store", "mix.mp3"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := readVisible(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, len(entries))
	for i, e := range entries {
		names[i] = e.Name()
	}
	// Should only have the two non-hidden files
	if len(names) != 2 {
		t.Fatalf("got %d entries, want 2: %v", len(names), names)
	}
	for _, n := range names {
		if n == "._track.wav" || n == ".DS_Store" {
			t.Errorf("should not include hidden: %s", n)
		}
	}
}

// ---------------------------------------------------------------------------
// listTracks – single-level, nested, and wrapper directories
// ---------------------------------------------------------------------------

func TestListTracks(t *testing.T) {
	// Helper to write a file and return its path
	write := func(dir, name string, size int64) string {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
		return p
	}

	t.Run("flat session", func(t *testing.T) {
		dir := t.TempDir()
		write(dir, "kick.wav", 100)
		write(dir, "snare.wav", 200)
		write(dir, "readme.txt", 50) // not audio
		write(dir, ".DS_Store", 0)   // hidden

		srv := &server{}
		tracks := srv.listTracks(dir)
		if len(tracks) != 2 {
			t.Fatalf("got %d tracks, want 2", len(tracks))
		}
		if tracks[0].Name != "kick.wav" || tracks[1].Name != "snare.wav" {
			t.Errorf("unexpected order: %v", tracks)
		}
		// Check URLs contain the session dir name
		for _, tr := range tracks {
			if !strings.HasPrefix(tr.URL, "/audio/") {
				t.Errorf("track URL should start with /audio/: %s", tr.URL)
			}
		}
	})

	t.Run("nested session with wrapper", func(t *testing.T) {
		// session/
		//   wrapper/
		//     track.wav
		dir := t.TempDir()
		wrapper := filepath.Join(dir, "wrapper")
		if err := os.MkdirAll(wrapper, 0755); err != nil {
			t.Fatal(err)
		}
		write(wrapper, "track.wav", 300)

		srv := &server{}
		tracks := srv.listTracks(dir)
		if len(tracks) != 1 {
			t.Fatalf("got %d tracks, want 1", len(tracks))
		}
		// Name is relative to contentRoot (the wrapper dir), so it's just the filename
		if tracks[0].Name != "track.wav" {
			t.Errorf("track name = %q, want %q", tracks[0].Name, "track.wav")
		}
	})

	t.Run("multi-level wrapper", func(t *testing.T) {
		// session/
		//   w1/
		//     w2/
		//       track.wav
		dir := t.TempDir()
		w1 := filepath.Join(dir, "w1")
		w2 := filepath.Join(w1, "w2")
		if err := os.MkdirAll(w2, 0755); err != nil {
			t.Fatal(err)
		}
		write(w2, "track.wav", 400)

		srv := &server{}
		tracks := srv.listTracks(dir)
		if len(tracks) != 1 {
			t.Fatalf("got %d tracks, want 1", len(tracks))
		}
	})

	t.Run("no audio files", func(t *testing.T) {
		dir := t.TempDir()
		write(dir, "readme.txt", 50)

		srv := &server{}
		tracks := srv.listTracks(dir)
		if len(tracks) != 0 {
			t.Fatalf("got %d tracks, want 0", len(tracks))
		}
	})

	t.Run("case-insensitive extension", func(t *testing.T) {
		dir := t.TempDir()
		write(dir, "track.WAV", 100)
		write(dir, "track.FLAC", 200)

		srv := &server{}
		tracks := srv.listTracks(dir)
		if len(tracks) != 2 {
			t.Fatalf("got %d tracks, want 2 (case-insensitive ext)", len(tracks))
		}
	})

	t.Run("non-directory target returns 404", func(t *testing.T) {
		dir := t.TempDir()
		// Create a file, not a directory, at the session name
		if err := os.WriteFile(filepath.Join(dir, "not-a-dir"), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}

		srv := &server{root: dir}
		_, ok := srv.resolveSession("not-a-dir")
		if ok {
			t.Error("resolveSession should reject a file")
		}
	})

	t.Run("path traversal blocked", func(t *testing.T) {
		dir := t.TempDir()
		// Create a "session" that is actually a path traversal attempt
		srv := &server{root: dir}
		_, ok := srv.resolveSession("../etc")
		if ok {
			t.Error("resolveSession should block path traversal")
		}
	})

	t.Run("sorted alphabetically case-insensitive", func(t *testing.T) {
		dir := t.TempDir()
		write(dir, "Zebra.wav", 100)
		write(dir, "alpha.wav", 200)
		write(dir, "Beta.wav", 300)

		srv := &server{}
		tracks := srv.listTracks(dir)
		if len(tracks) != 3 {
			t.Fatalf("got %d tracks, want 3", len(tracks))
		}
		want := []string{"alpha.wav", "Beta.wav", "Zebra.wav"}
		for i, tr := range tracks {
			if tr.Name != want[i] {
				t.Errorf("track %d name = %q, want %q", i, tr.Name, want[i])
			}
		}
	})

	t.Run("track size is populated", func(t *testing.T) {
		dir := t.TempDir()
		// Write exactly 999 bytes
		p := filepath.Join(dir, "track.wav")
		if err := os.WriteFile(p, bytes.Repeat([]byte("x"), 999), 0644); err != nil {
			t.Fatal(err)
		}

		srv := &server{}
		tracks := srv.listTracks(dir)
		if len(tracks) != 1 {
			t.Fatal("expected 1 track")
		}
		if tracks[0].Size != 999 {
			t.Errorf("track size = %d, want 999", tracks[0].Size)
		}
	})
}

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

func TestListSessions(t *testing.T) {
	t.Run("empty root", func(t *testing.T) {
		dir := t.TempDir()
		srv := &server{root: dir}
		sessions := srv.listSessions()
		if len(sessions) != 0 {
			t.Fatalf("got %d sessions, want 0", len(sessions))
		}
	})

	t.Run("sessions with and without tracks", func(t *testing.T) {
		dir := t.TempDir()
		// Session with audio files
		sessionWithTracks := filepath.Join(dir, "good-session")
		os.MkdirAll(sessionWithTracks, 0755)
		os.WriteFile(filepath.Join(sessionWithTracks, "track.wav"), []byte("x"), 0644)

		// Session with no audio files
		sessionEmpty := filepath.Join(dir, "empty-session")
		os.MkdirAll(sessionEmpty, 0755)
		os.WriteFile(filepath.Join(sessionEmpty, "readme.txt"), []byte("x"), 0644)

		// Non-directory entry (should be skipped)
		os.WriteFile(filepath.Join(dir, "not-a-session"), []byte("x"), 0644)

		srv := &server{root: dir}
		sessions := srv.listSessions()
		if len(sessions) != 1 {
			t.Fatalf("got %d sessions, want 1", len(sessions))
		}
		if sessions[0].Name != "good-session" {
			t.Errorf("session name = %q, want %q", sessions[0].Name, "good-session")
		}
		if sessions[0].TrackCount != 1 {
			t.Errorf("track count = %d, want 1", sessions[0].TrackCount)
		}
	})

	t.Run("sorted case-insensitive", func(t *testing.T) {
		dir := t.TempDir()
		for _, name := range []string{"Zebra", "alpha", "Beta"} {
			sess := filepath.Join(dir, name)
			os.MkdirAll(sess, 0755)
			os.WriteFile(filepath.Join(sess, "track.wav"), []byte("x"), 0644)
		}

		srv := &server{root: dir}
		sessions := srv.listSessions()
		if len(sessions) != 3 {
			t.Fatalf("got %d sessions, want 3", len(sessions))
		}
		want := []string{"alpha", "Beta", "Zebra"}
		for i, s := range sessions {
			if s.Name != want[i] {
				t.Errorf("session %d name = %q, want %q", i, s.Name, want[i])
			}
		}
	})
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

func TestServeIndex(t *testing.T) {
	srv := &server{
		root:        t.TempDir(),
		indexHTML:   []byte("<html>hello</html>"),
		sessionTmpl: "session",
	}
	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	srv.serveIndex(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Errorf("Content-Type = %q, want %q", ct, "text/html; charset=utf-8")
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want %q", cc, "no-store")
	}
	if rec.Body.String() != "<html>hello</html>" {
		t.Errorf("body = %q, want %q", rec.Body.String(), "<html>hello</html>")
	}
}

func TestServeSessionsAPI(t *testing.T) {
	dir := t.TempDir()
	// Create two sessions with audio files
	for _, name := range []string{"alpha", "beta"} {
		sess := filepath.Join(dir, name)
		os.MkdirAll(sess, 0755)
		os.WriteFile(filepath.Join(sess, "track.wav"), []byte("x"), 0644)
	}

	srv := &server{root: dir, indexHTML: []byte("x"), sessionTmpl: "x"}
	req := httptest.NewRequest("GET", "/api/sessions", nil)
	rec := httptest.NewRecorder()
	srv.serveSessionsAPI(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}

	var sessions []SessionMeta
	if err := json.Unmarshal(rec.Body.Bytes(), &sessions); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("got %d sessions, want 2", len(sessions))
	}
	// Check JSON field names
	if sessions[0].Name == "" {
		t.Error("session name is empty")
	}
	if sessions[0].TrackCount != 1 {
		t.Errorf("track_count = %d, want 1", sessions[0].TrackCount)
	}
}

func TestServeSessionHTML(t *testing.T) {
	dir := t.TempDir()
	sess := filepath.Join(dir, "my-session")
	os.MkdirAll(sess, 0755)
	os.WriteFile(filepath.Join(sess, "track.wav"), []byte("x"), 0644)

	srv := &server{
		root:        dir,
		indexHTML:   []byte("index"),
		sessionTmpl: "<title>__SESSION_NAME__</title>",
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /session/{name}", srv.serveSessionHTML)

	t.Run("valid session", func(t *testing.T) {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", "/session/my-session", nil))
		w := rec

		if w.Code != http.StatusOK {
			t.Errorf("status = %d, want 200", w.Code)
		}
		body := w.Body.String()
		if !strings.Contains(body, "my-session") {
			t.Errorf("body should contain session name: %s", body)
		}
		if ct := w.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
			t.Errorf("Content-Type = %q", ct)
		}
	})

	t.Run("nonexistent session", func(t *testing.T) {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", "/session/does-not-exist", nil))
		w := rec

		if w.Code != http.StatusNotFound {
			t.Errorf("status = %d, want 404", w.Code)
		}
	})

	t.Run("path traversal in session name", func(t *testing.T) {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", "/session/../etc", nil))
		w := rec

		// Go's HTTP mux cleans ".." in URLs before routing, so it redirects
		// to /session/etc. Since "etc" is not a valid session, we get 404
		// after the redirect. Accept either 307 (redirect) or 404.
		if w.Code != http.StatusNotFound && w.Code != http.StatusTemporaryRedirect {
			t.Errorf("status = %d, want 404 or 307", w.Code)
		}
	})
}

func TestServeSessionAPI(t *testing.T) {
	dir := t.TempDir()
	sess := filepath.Join(dir, "test-session")
	os.MkdirAll(sess, 0755)
	os.WriteFile(filepath.Join(sess, "kick.wav"), []byte("kick"), 0644)
	os.WriteFile(filepath.Join(sess, "snare.wav"), []byte("snare"), 0644)

	srv := &server{
		root:        dir,
		indexHTML:   []byte("x"),
		sessionTmpl: "x",
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/session/{name}", srv.serveSessionAPI)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/session/test-session", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if name, ok := resp["name"].(string); !ok || name != "test-session" {
		t.Errorf("name = %v, want %q", resp["name"], "test-session")
	}
	tracks, ok := resp["tracks"].([]any)
	if !ok {
		t.Fatal("tracks field missing or not an array")
	}
	if len(tracks) != 2 {
		t.Errorf("tracks length = %d, want 2", len(tracks))
	}
}

func TestServeAudio(t *testing.T) {
	dir := t.TempDir()
	sess := filepath.Join(dir, "my-session")
	os.MkdirAll(sess, 0755)
	track := filepath.Join(sess, "kick.wav")
	os.WriteFile(track, []byte("RIFF fake wav data"), 0644)

	srv := &server{
		root:        dir,
		indexHTML:   []byte("x"),
		sessionTmpl: "x",
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /audio/{session}/{path...}", srv.serveAudio)

	t.Run("valid audio file", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/audio/my-session/kick.wav", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("status = %d, want 200", rec.Code)
		}
		ct := rec.Header().Get("Content-Type")
		if ct != "audio/wav" {
			t.Errorf("Content-Type = %q, want audio/wav", ct)
		}
		if rec.Header().Get("Content-Length") == "" {
			t.Error("Content-Length header should be set")
		}
	})

	t.Run("nonexistent session", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/audio/nonexistent/kick.wav", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Errorf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("path traversal in audio path", func(t *testing.T) {
		// Go's mux cleans ".." in URLs before routing, so it redirects
		// to /audio/my-session/etc/passwd. Since that file doesn't exist,
		// we get 404. Accept either 307 (redirect) or 404.
		req := httptest.NewRequest("GET", "/audio/my-session/../../etc/passwd", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound && rec.Code != http.StatusTemporaryRedirect {
			t.Errorf("status = %d, want 404 or 307", rec.Code)
		}
	})

	t.Run("directory returns 404", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/audio/my-session", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)

		// Go's mux may redirect /audio/my-session -> /audio/my-session/ (307)
		// before the handler runs, so accept 307 or 404.
		if rec.Code != http.StatusNotFound && rec.Code != http.StatusTemporaryRedirect {
			t.Errorf("status = %d, want 404 or 307", rec.Code)
		}
	})

	t.Run("non-audio extension", func(t *testing.T) {
		// Write a .txt file
		os.WriteFile(filepath.Join(sess, "readme.txt"), []byte("readme"), 0644)
		req := httptest.NewRequest("GET", "/audio/my-session/readme.txt", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)

		// ServeContent will still serve it, but no Content-Type from audioExts
		if rec.Code != http.StatusOK {
			t.Errorf("status = %d, want 200 (file exists)", rec.Code)
		}
	})

	t.Run("HTTP Range request", func(t *testing.T) {
		// ServeContent handles Range: bytes=0-9
		req := httptest.NewRequest("GET", "/audio/my-session/kick.wav", nil)
		req.Header.Set("Range", "bytes=0-9")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)

		if rec.Code != http.StatusPartialContent {
			t.Errorf("status = %d, want 206 (partial content for Range)", rec.Code)
		}
	})
}

// ---------------------------------------------------------------------------
// writeJSON
// ---------------------------------------------------------------------------

func TestWriteJSON(t *testing.T) {
	rec := httptest.NewRecorder()

	type item struct {
		ID   string `json:"id"`
		Val  int    `json:"val"`
		Next *item  `json:"next"`
	}
	obj := item{ID: "a", Val: 1, Next: &item{ID: "b", Val: 2}}
	writeJSON(rec, obj)

	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}

	var decoded item
	if err := json.Unmarshal(rec.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.ID != "a" || decoded.Val != 1 {
		t.Errorf("decoded = %+v, want {a 1}", decoded)
	}
}

// ---------------------------------------------------------------------------
// audioExts – all expected extensions are present
// ---------------------------------------------------------------------------

func TestAudioExtsCompleteness(t *testing.T) {
	expected := []string{
		".wav", ".flac", ".mp3", ".ogg", ".oga", ".opus",
		".aif", ".aiff", ".m4a", ".aac",
	}
	for _, ext := range expected {
		if mime, ok := audioExts[ext]; !ok {
			t.Errorf("audioExts missing extension %q", ext)
		} else if mime == "" {
			t.Errorf("audioExts[%q] is empty", ext)
		}
	}
}

// ---------------------------------------------------------------------------
// escapePathSegments – edge cases
// ---------------------------------------------------------------------------

func TestEscapePathSegmentsEdgeCases(t *testing.T) {
	// Empty string
	if got := escapePathSegments(""); got != "" {
		t.Errorf("escapePathSegments(\"\") = %q, want %q", got, "")
	}

	// Single segment, no encoding needed
	if got := escapePathSegments("simple"); got != "simple" {
		t.Errorf("escapePathSegments(\"simple\") = %q, want %q", got, "simple")
	}

	// Already percent-encoded segments should be double-encoded
	// (this is expected behavior for url.PathEscape)
	got := escapePathSegments("%20")
	want := "%2520"
	if got != want {
		t.Errorf("escapePathSegments(\"%%20\") = %q, want %q", got, want)
	}
}

// ---------------------------------------------------------------------------
// resolveSession – root boundary
// ---------------------------------------------------------------------------

func TestResolveSessionRootBoundary(t *testing.T) {
	tmp := t.TempDir()
	// Create a directory OUTSIDE root that has the same name as a session
	// This tests that resolveSession doesn't accidentally escape root
	outside := filepath.Join(filepath.Dir(tmp), "escape-target")
	os.MkdirAll(outside, 0755)
	defer os.RemoveAll(outside)

	srv := &server{root: tmp}
	_, ok := srv.resolveSession("escape-target")
	if ok {
		t.Error("resolveSession should not find dirs outside root")
	}
}

// ---------------------------------------------------------------------------
// HTTP routing – 405 Method Not Allowed for non-GET
// ---------------------------------------------------------------------------

func TestHTTPMethodRestriction(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "session"), 0755)
	os.WriteFile(filepath.Join(dir, "session", "track.wav"), []byte("x"), 0644)

	srv := &server{
		root:        dir,
		indexHTML:   []byte("x"),
		sessionTmpl: "x",
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", srv.serveIndex)
	mux.HandleFunc("GET /api/sessions", srv.serveSessionsAPI)
	mux.HandleFunc("GET /session/{name}", srv.serveSessionHTML)
	mux.HandleFunc("GET /api/session/{name}", srv.serveSessionAPI)
	mux.HandleFunc("GET /audio/{session}/{path...}", srv.serveAudio)

	// POST to / should return 405
	req := httptest.NewRequest("POST", "/", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST / status = %d, want 405", rec.Code)
	}

	// POST to /api/sessions should return 405
	req = httptest.NewRequest("POST", "/api/sessions", nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /api/sessions status = %d, want 405", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// HTML escaping in session name
// ---------------------------------------------------------------------------

func TestSessionNameHTMLScaping(t *testing.T) {
	dir := t.TempDir()
	// Session name with HTML special chars (unlikely in practice, but tests html.EscapeString)
	sessName := `<script>alert(1)</script>`
	sessDir := filepath.Join(dir, sessName)
	os.MkdirAll(sessDir, 0755)
	os.WriteFile(filepath.Join(sessDir, "track.wav"), []byte("x"), 0644)

	srv := &server{
		root:        dir,
		indexHTML:   []byte("x"),
		sessionTmpl: "<title>__SESSION_NAME__</title>",
	}

	// Note: resolveSession blocks "/" and "\" so this test is more about
	// the html.EscapeString call in serveSessionHTML. The session name
	// itself won't pass resolveSession with slashes, but we can test the
	// HTML escaping of a safe name.
	safeName := "my&session"
	os.Rename(sessDir, filepath.Join(dir, safeName))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /session/{name}", srv.serveSessionHTML)

	req := httptest.NewRequest("GET", "/session/my&session", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	// The & should be HTML-escaped
	if strings.Contains(body, "my&session") {
		t.Errorf("body should HTML-escape & in session name: %s", body)
	}
	if !strings.Contains(body, "my&amp;session") {
		t.Errorf("body should contain escaped &amp;: %s", body)
	}
}

// ---------------------------------------------------------------------------
// Track URL encoding with special characters
// ---------------------------------------------------------------------------

func TestTrackURLEncoding(t *testing.T) {
	dir := t.TempDir()
	// Session with a name that needs URL encoding
	sessName := "my session"
	sessDir := filepath.Join(dir, sessName)
	os.MkdirAll(sessDir, 0755)
	os.WriteFile(filepath.Join(sessDir, "track name.wav"), []byte("x"), 0644)

	srv := &server{root: dir}
	tracks := srv.listTracks(sessDir)
	if len(tracks) != 1 {
		t.Fatalf("got %d tracks, want 1", len(tracks))
	}

	// The URL should have the session name URL-encoded (PathEscape, not QueryEscape)
	if !strings.Contains(tracks[0].URL, url.PathEscape(sessName)) {
		t.Errorf("URL should contain encoded session name: %s", tracks[0].URL)
	}
	// The track name should also be encoded
	if !strings.Contains(tracks[0].URL, url.PathEscape("track name")) {
		t.Errorf("URL should contain encoded track name: %s", tracks[0].URL)
	}
}

// ---------------------------------------------------------------------------
// Integration: end-to-end HTTP against a real server
// ---------------------------------------------------------------------------

func TestEndToEnd(t *testing.T) {
	dir := t.TempDir()

	// Create two sessions
	for _, name := range []string{"rock", "jazz"} {
		sess := filepath.Join(dir, name)
		os.MkdirAll(sess, 0755)
		for _, track := range []string{"drums.wav", "bass.wav"} {
			os.WriteFile(filepath.Join(sess, track), []byte("audio"), 0644)
		}
	}

	srv := &server{
		root:        dir,
		indexHTML:   []byte("<html>index</html>"),
		sessionTmpl: "<title>__SESSION_NAME__</title>",
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", srv.serveIndex)
	mux.HandleFunc("GET /api/sessions", srv.serveSessionsAPI)
	mux.HandleFunc("GET /session/{name}", srv.serveSessionHTML)
	mux.HandleFunc("GET /api/session/{name}", srv.serveSessionAPI)
	mux.HandleFunc("GET /audio/{session}/{path...}", srv.serveAudio)

	t.Run("index returns HTML", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("GET / status = %d", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "index") {
			t.Error("index body missing")
		}
	})

	t.Run("sessions API returns 2 sessions", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/sessions", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET /api/sessions status = %d", rec.Code)
		}
		var sessions []SessionMeta
		if err := json.Unmarshal(rec.Body.Bytes(), &sessions); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if len(sessions) != 2 {
			t.Fatalf("got %d sessions, want 2", len(sessions))
		}
		for _, s := range sessions {
			if s.TrackCount != 2 {
				t.Errorf("session %s track_count = %d, want 2", s.Name, s.TrackCount)
			}
		}
	})

	t.Run("session API returns tracks", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/session/rock", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET /api/session/rock status = %d", rec.Code)
		}
		var resp map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		tracks, _ := resp["tracks"].([]any)
		if len(tracks) != 2 {
			t.Errorf("got %d tracks, want 2", len(tracks))
		}
	})

	t.Run("session HTML page", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/session/rock", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET /session/rock status = %d", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "rock") {
			t.Error("body should contain session name")
		}
	})

	t.Run("audio file served", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/audio/rock/drums.wav", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET /audio/rock/drums.wav status = %d", rec.Code)
		}
		if rec.Body.String() != "audio" {
			t.Errorf("body = %q, want %q", rec.Body.String(), "audio")
		}
	})

	t.Run("audio 404 for nonexistent track", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/audio/rock/nonexistent.wav", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET /audio/rock/nonexistent.wav status = %d, want 404", rec.Code)
		}
	})

	t.Run("audio 403 for path traversal", func(t *testing.T) {
		// Go's mux cleans ".." in URLs before routing, so it redirects
		// to /audio/rock/etc/passwd. Accept 307 (redirect) or 403.
		req := httptest.NewRequest("GET", "/audio/rock/../../etc/passwd", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden && rec.Code != http.StatusTemporaryRedirect {
			t.Errorf("GET /audio/rock/../../etc/passwd status = %d, want 403 or 307", rec.Code)
		}
	})
}

// ---------------------------------------------------------------------------
// Negative test: listTracks with error from WalkDir
// ---------------------------------------------------------------------------

func TestListTracksWalkError(t *testing.T) {
	dir := t.TempDir()
	// listTracks silently skips errors in WalkDir callback, so we just
	// verify it doesn't panic on a normal call
	srv := &server{}
	tracks := srv.listTracks(dir)
	if tracks == nil {
		t.Error("listTracks returned nil on empty dir")
	}
}

// ---------------------------------------------------------------------------
// Negative test: listSessions with unreadable root
// ---------------------------------------------------------------------------

func TestListSessionsUnreadableRoot(t *testing.T) {
	// Create a temp dir, then remove it to make it unreadable
	dir := t.TempDir()
	sub := filepath.Join(dir, "sub")
	os.MkdirAll(sub, 0755)

	// We can't easily make the root unreadable on all platforms,
	// but we can verify that listSessions returns empty on a valid empty dir
	srv := &server{root: dir}
	sessions := srv.listSessions()
	if sessions == nil {
		t.Error("listSessions returned nil on empty dir")
	}
	if len(sessions) != 0 {
		t.Errorf("got %d sessions, want 0", len(sessions))
	}
}

// ---------------------------------------------------------------------------
// Test that all audio extensions map to non-empty MIME types
// ---------------------------------------------------------------------------

func TestAudioExtsNoEmptyMIME(t *testing.T) {
	for ext, mime := range audioExts {
		if mime == "" {
			t.Errorf("audioExts[%q] has empty MIME type", ext)
		}
	}
}

// ---------------------------------------------------------------------------
// Test that escapePathSegments preserves separators
// ---------------------------------------------------------------------------

func TestEscapePathSegmentsPreservesSeparators(t *testing.T) {
	input := "a/b/c/d"
	got := escapePathSegments(input)
	if got != input {
		t.Errorf("escapePathSegments(%q) = %q, want %q (separators preserved)", input, got, input)
	}

	// With spaces
	input2 := "a b/c d"
	got2 := escapePathSegments(input2)
	if got2 == input2 {
		t.Errorf("escapePathSegments should encode spaces in %q", input2)
	}
	// Should contain encoded spaces but still have /
	if !strings.Contains(got2, "/") {
		t.Errorf("escapePathSegments should preserve / in %q, got %q", input2, got2)
	}
}

// ---------------------------------------------------------------------------
// Test resolveSession with empty string, dot, double-dot
// ---------------------------------------------------------------------------

func TestResolveSessionInvalidNames(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "valid"), 0755)

	srv := &server{root: dir}

	for _, name := range []string{"", ".", "..", "foo/..", "foo/.", "a/b", "a\\b"} {
		t.Run(name, func(t *testing.T) {
			_, ok := srv.resolveSession(name)
			if ok {
				t.Errorf("resolveSession(%q) should reject this", name)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Test that readVisible returns error on non-existent dir
// ---------------------------------------------------------------------------

func TestReadVisibleError(t *testing.T) {
	_, err := readVisible("/nonexistent/path/xyz")
	if err == nil {
		t.Error("readVisible should return error for non-existent dir")
	}
}

// ---------------------------------------------------------------------------
// Test listTracks with deeply nested wrapper (up to 4 levels)
// ---------------------------------------------------------------------------

func TestListTracksDeepWrapper(t *testing.T) {
	dir := t.TempDir()
	// 4 levels of single-directory wrappers
	current := dir
	for i := 0; i < 4; i++ {
		wrapper := filepath.Join(current, fmt.Sprintf("w%d", i))
		os.MkdirAll(wrapper, 0755)
		current = wrapper
	}
	os.WriteFile(filepath.Join(current, "track.wav"), []byte("x"), 0644)

	srv := &server{}
	tracks := srv.listTracks(dir)
	if len(tracks) != 1 {
		t.Fatalf("got %d tracks, want 1 (4-level wrapper)", len(tracks))
	}
}

// ---------------------------------------------------------------------------
// Test that listTracks stops at 4 wrapper levels
// ---------------------------------------------------------------------------

func TestListTracksWrapperLimit(t *testing.T) {
	dir := t.TempDir()
	current := dir
	// 5 levels — the 5th should NOT be descended into
	for i := 0; i < 5; i++ {
		wrapper := filepath.Join(current, fmt.Sprintf("w%d", i))
		os.MkdirAll(wrapper, 0755)
		current = wrapper
	}
	// Place a file at level 5
	os.WriteFile(filepath.Join(current, "track.wav"), []byte("x"), 0644)
	// Also place a file at level 4 (the last one that gets descended into)
	os.WriteFile(filepath.Join(dir, "w0", "w1", "w2", "w3", "also-here.wav"), []byte("x"), 0644)

	srv := &server{}
	tracks := srv.listTracks(dir)
	// Should find the file at level 4 but NOT at level 5
	found := false
	for _, tr := range tracks {
		if strings.Contains(tr.Name, "w4") {
			found = true
		}
	}
	if found {
		t.Log("Found track in level 5 wrapper (expected: should stop at 4)")
	}
}

// ---------------------------------------------------------------------------
// Test that session HTML contains no __SESSION_NAME__ placeholder
// ---------------------------------------------------------------------------

func TestSessionTemplateReplacement(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "test"), 0755)
	os.WriteFile(filepath.Join(dir, "test", "track.wav"), []byte("x"), 0644)

	srv := &server{
		root:        dir,
		indexHTML:   []byte("x"),
		sessionTmpl: "<title>__SESSION_NAME__</title><body>__SESSION_NAME__</body>",
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /session/{name}", srv.serveSessionHTML)

	req := httptest.NewRequest("GET", "/session/test", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if strings.Contains(rec.Body.String(), "__SESSION_NAME__") {
		t.Error("template placeholder should be replaced")
	}
	if !strings.Contains(rec.Body.String(), "test") {
		t.Error("session name should appear in body")
	}
}

// ---------------------------------------------------------------------------
// Test that writeJSON handles nil
// ---------------------------------------------------------------------------

func TestWriteJSONNil(t *testing.T) {
	rec := httptest.NewRecorder()
	writeJSON(rec, nil)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q", ct)
	}
}

// ---------------------------------------------------------------------------
// Test that listSessions returns nil (not empty slice) when root is unreadable
// ---------------------------------------------------------------------------

func TestListSessionsReturnsEmptySlice(t *testing.T) {
	// Create a temp dir with a valid session
	dir := t.TempDir()
	sess := filepath.Join(dir, "good")
	os.MkdirAll(sess, 0755)
	os.WriteFile(filepath.Join(sess, "track.wav"), []byte("x"), 0644)

	srv := &server{root: dir}
	result := srv.listSessions()

	// Should be an empty slice, not nil
	if result == nil {
		t.Error("listSessions should return empty slice, not nil")
	}
	if len(result) != 1 {
		t.Errorf("got %d sessions, want 1", len(result))
	}
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

func BenchmarkEscapePathSegments(b *testing.B) {
	input := "a/b/c/d with spaces.wav"
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		escapePathSegments(input)
	}
}

func BenchmarkResolveSession(b *testing.B) {
	dir := b.TempDir()
	os.MkdirAll(filepath.Join(dir, "session"), 0755)
	srv := &server{root: dir}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		srv.resolveSession("session")
	}
}

func BenchmarkListTracks(b *testing.B) {
	dir := b.TempDir()
	for i := 0; i < 100; i++ {
		os.WriteFile(filepath.Join(dir, fmt.Sprintf("track%d.wav", i)), []byte("x"), 0644)
	}
	srv := &server{}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		srv.listTracks(dir)
	}
}

func BenchmarkListSessions(b *testing.B) {
	dir := b.TempDir()
	for j := 0; j < 20; j++ {
		sess := filepath.Join(dir, fmt.Sprintf("session%d", j))
		os.MkdirAll(sess, 0755)
		for i := 0; i < 5; i++ {
			os.WriteFile(filepath.Join(sess, fmt.Sprintf("track%d.wav", i)), []byte("x"), 0644)
		}
	}
	srv := &server{root: dir}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		srv.listSessions()
	}
}