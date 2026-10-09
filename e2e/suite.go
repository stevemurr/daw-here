package e2e

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/chromedp/chromedp"
)

//go:embed web/session.html
//go:embed web/index.html
//go:embed web/mixer.js
//go:embed web/components/config.js
//go:embed web/components/fx-strip.js
//go:embed web/components/track.js
//go:embed web/components/player.js
var testWeb embed.FS

// ---------------------------------------------------------------------------
// Server helpers
// ---------------------------------------------------------------------------

type testServer struct {
	root        string
	indexHTML   []byte
	sessionTmpl string
	configJS    []byte
	fxStripJS   []byte
	mixerJS     []byte
	trackJS     []byte
	playerJS    []byte
}

func makeTestServer(t *testing.T) *httptest.Server {
	t.Helper()

	tmpRoot := t.TempDir()
	sessDir := filepath.Join(tmpRoot, "e2e-session")
	if err := os.MkdirAll(sessDir, 0755); err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{"kick.wav", "snare.wav", "hat.ogg"} {
		path := filepath.Join(sessDir, name)
		data := wavHeader()
		if err := os.WriteFile(path, data, 0644); err != nil {
			t.Fatal(err)
		}
	}

	indexBytes, _ := fs.ReadFile(testWeb, "web/index.html")
	sessionBytes, _ := fs.ReadFile(testWeb, "web/session.html")
	configJSBytes, _ := fs.ReadFile(testWeb, "web/components/config.js")
	fxStripJSBytes, _ := fs.ReadFile(testWeb, "web/components/fx-strip.js")
	mixerJSBytes, _ := fs.ReadFile(testWeb, "web/mixer.js")
	trackJSBytes, _ := fs.ReadFile(testWeb, "web/components/track.js")
	playerJSBytes, _ := fs.ReadFile(testWeb, "web/components/player.js")

	srv := &testServer{
		root:        tmpRoot,
		indexHTML:   indexBytes,
		sessionTmpl: string(sessionBytes),
		configJS:    configJSBytes,
		fxStripJS:   fxStripJSBytes,
		mixerJS:     mixerJSBytes,
		trackJS:     trackJSBytes,
		playerJS:    playerJSBytes,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", srv.serveIndex)
	mux.HandleFunc("GET /api/sessions", srv.serveSessionsAPI)
	mux.HandleFunc("GET /session/{name}", srv.serveSessionHTML)
	mux.HandleFunc("GET /api/session/{name}", srv.serveSessionAPI)
	mux.HandleFunc("GET /audio/{session}/{path...}", srv.serveAudio)
	mux.HandleFunc("GET /components/config.js", srv.serveConfigJS)
	mux.HandleFunc("GET /components/fx-strip.js", srv.serveFxStripJS)
	mux.HandleFunc("GET /mixer.js", srv.serveMixersJS)
	mux.HandleFunc("GET /components/track.js", srv.serveTrackJS)
	mux.HandleFunc("GET /components/player.js", srv.servePlayerJS)

	return httptest.NewServer(mux)
}

// Browser returns a chromedp context and cancel function for running browser
// actions. Chrome is launched headless.
func Browser(ctx context.Context) (context.Context, context.CancelFunc) {
	allocCtx, allocCancel := chromedp.NewExecAllocator(ctx,
		chromedp.NoSandbox,
		chromedp.Headless,
		chromedp.ExecPath("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
		chromedp.WindowSize(1280, 800),
	)
	taskCtx, taskCancel := chromedp.NewContext(allocCtx)
	return taskCtx, func() {
		taskCancel()
		allocCancel()
	}
}

// Run executes chromedp actions within the given context.
func Run(ctx context.Context, actions ...chromedp.Action) error {
	return chromedp.Run(ctx, actions...)
}

// NavigateTo navigates to url and waits for load complete.
func NavigateTo(ctx context.Context, url string) chromedp.Action {
	return chromedp.Navigate(url)
}

// WaitForTimeout pauses for the specified duration during a chromedp action chain.
func WaitForTimeout(d time.Duration) chromedp.Action {
	return chromedp.Sleep(d)
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

// wavHeader returns a minimal valid RIFF/WAV header so files pass MIME checks.
func wavHeader() []byte {
	return []byte{
		0x52, 0x49, 0x46, 0x46, // "RIFF"
		0x24, 0x00, 0x00, 0x00, // file size - 8 = 36 bytes payload
		0x57, 0x41, 0x56, 0x45, // "WAVE"
		0x66, 0x6d, 0x74, 0x20, // "fmt "
		0x10, 0x00, 0x00, 0x00, // chunk size: 16 (PCM)
		0x01, 0x00,             // audio format: 1 (PCM)
		0x01, 0x00,             // num channels: 1
		0x80, 0x3e, 0x00, 0x00, // sample rate: 16000
		0x80, 0x3e, 0x00, 0x00, // byte rate: 16000
		0x01, 0x00,             // block align: 1
		0x08, 0x00,             // bits per sample: 8
		0x64, 0x61, 0x74, 0x61, // "data"
		0x20, 0x00, 0x00, 0x00, // data chunk size: 32
	}
}

// ---------------------------------------------------------------------------
func (s *testServer) serveIndex(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(s.indexHTML)
}

func (s *testServer) serveSessionsAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	entries, _ := os.ReadDir(s.root)
	out := "["
	sep := ""
	for _, e := range entries {
		if !e.IsDir() { continue }
		count := trackCount(filepath.Join(s.root, e.Name()))
		if count == 0 { continue }
		out += sep + fmt.Sprintf(`{"name":"%s","track_count":%d}`, e.Name(), count)
		sep = ","
	}
	out += "]"
	w.Write([]byte(out))
}

func (s *testServer) serveSessionHTML(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/session/")
	body := strings.ReplaceAll(s.sessionTmpl, "__SESSION_NAME__", name)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write([]byte(body))
}

func (s *testServer) serveSessionAPI(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/api/session/")
	tracks := listTracksForAPI(filepath.Join(s.root, name))
	fmt.Fprintf(w, `{"name":"%s","tracks":%s}`+"\n", name, tracks)
}

func (s *testServer) serveAudio(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/audio/")
	idx := strings.Index(path, "/")
	if idx < 0 {
		http.NotFound(w, r)
		return
	}
	file := filepath.Join(s.root, path[idx+1:])
	data, err := os.ReadFile(file)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "audio/wav")
	w.Write(data)
}

func (s *testServer) serveMixersJS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript")
	w.Write(s.mixerJS)
}
func (s *testServer) serveConfigJS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Write(s.configJS)
}
func (s *testServer) serveFxStripJS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Write(s.fxStripJS)
}
func (s *testServer) serveTrackJS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Write(s.trackJS)
}
func (s *testServer) servePlayerJS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Write(s.playerJS)
}

func trackCount(dir string) int {
	count := 0
	filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() { return nil }
		ext := strings.ToLower(filepath.Ext(d.Name()))
		switch ext {
		case ".wav", ".flac", ".mp3", ".ogg", ".oga", ".opus",
			".aif", ".aiff", ".m4a", ".aac":
			count++
		}
		return nil
	})
	return count
}

func listTracksForAPI(dir string) string {
	entries, _ := os.ReadDir(dir)
	if len(entries) == 0 {
		return "[]"
	}
	out := "["
	sep := ""
	for _, e := range entries {
		ext := strings.ToLower(filepath.Ext(e.Name()))
		switch ext {
		case ".wav", ".flac", ".mp3", ".ogg", ".oga", ".opus",
			".aif", ".aiff", ".m4a", ".aac":
			out += sep + fmt.Sprintf(`{"name":"%s","url":"/audio/e2e-session/%s","size":0}`, e.Name(), e.Name())
			sep = ","
		}
	}
	out += "]"
	return out
}

// shadowEval evaluates JS inside the <daw-player> component's shadow DOM.
// It first waits for the custom element to be defined (ensuring modules loaded),
// then evaluates the expression synchronously against the shadowRoot.
func shadowEval(ctx context.Context, js string, result interface{}) error {
	// Step 1: Wait for daw-player custom element to be defined
	if err := chromedp.Run(ctx, 
		chromedp.Evaluate(`customElements.whenDefined('daw-player')`, nil),
	); err != nil {
		return fmt.Errorf("waiting for daw-player: %w", err)
	}
	// Step 2: Evaluate the actual expression in the shadowRoot
	wrapped := fmt.Sprintf(`
(function() {
  var el = document.querySelector('daw-player');
  if (!el || !el.shadowRoot) return 'Error:no-shadow-root';
  try { return %s } catch(e) { return 'Error:'+e.message; }
})()
`, js)
	// chromedp.Evaluate with WithReturnByValue=true will return JSON-encoded values
	// For strings/booleans, chromedp passes them through directly
	var raw json.RawMessage
	if err := chromedp.Run(ctx, chromedp.Evaluate(wrapped, &raw)); err != nil {
		return err
	}
	if raw == nil {
		return nil
	}
	// Try numeric/bool first
	switch r := result.(type) {
	case *bool:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return err
		}
		*r = s == "true"
		return nil
	case *float64:
		return json.Unmarshal(raw, r)
	}
	// Default: assume string
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return err
	}
	switch r := result.(type) {
	case *string:
		*r = s
		return nil
	case *int:
		_, _ = fmt.Sscanf(s, "%d", r)
		return nil
	}
	// Fallback: try direct unmarshal
	return json.Unmarshal(raw, result)
}
