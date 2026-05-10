// Package main is a single-binary, browser-based DAW-style audition server
// for a folder of multitrack sessions.
//
// Each immediate subdirectory of --root is treated as a session; every audio
// file inside becomes a track. The browser loads all tracks for a session
// and plays them back in sample-accurate sync with per-track volume, pan,
// mute/solo, EQ, compressor, delay and reverb.
package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"html"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

//go:embed web/*
var webFS embed.FS

// audioExts maps file extension (lower-case, with dot) to MIME type. We carry
// our own table because Go's mime package doesn't reliably know .flac/.opus.
var audioExts = map[string]string{
	".wav":  "audio/wav",
	".flac": "audio/flac",
	".mp3":  "audio/mpeg",
	".ogg":  "audio/ogg",
	".oga":  "audio/ogg",
	".opus": "audio/opus",
	".aif":  "audio/aiff",
	".aiff": "audio/aiff",
	".m4a":  "audio/mp4",
	".aac":  "audio/aac",
}

type Track struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Size int64  `json:"size"`
}

type SessionMeta struct {
	Name       string `json:"name"`
	TrackCount int    `json:"track_count"`
}

type server struct {
	root        string
	indexHTML   []byte
	sessionTmpl string
}

func main() {
	root := flag.String("root", ".", "directory containing session subdirectories")
	port := flag.Int("port", 8765, "TCP port to listen on")
	host := flag.String("host", "127.0.0.1", "host to bind to (use 0.0.0.0 to expose on the LAN)")
	flag.Parse()

	absRoot, err := filepath.Abs(*root)
	if err != nil {
		log.Fatalf("invalid --root: %v", err)
	}
	info, err := os.Stat(absRoot)
	if err != nil || !info.IsDir() {
		log.Fatalf("--root not a directory: %s", absRoot)
	}

	indexBytes, err := fs.ReadFile(webFS, "web/index.html")
	if err != nil {
		log.Fatalf("loading index.html: %v", err)
	}
	sessionBytes, err := fs.ReadFile(webFS, "web/session.html")
	if err != nil {
		log.Fatalf("loading session.html: %v", err)
	}

	srv := &server{
		root:        absRoot,
		indexHTML:   indexBytes,
		sessionTmpl: string(sessionBytes),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", srv.serveIndex)
	mux.HandleFunc("GET /api/sessions", srv.serveSessionsAPI)
	mux.HandleFunc("GET /session/{name}", srv.serveSessionHTML)
	mux.HandleFunc("GET /api/session/{name}", srv.serveSessionAPI)
	mux.HandleFunc("GET /audio/{session}/{path...}", srv.serveAudio)

	addr := fmt.Sprintf("%s:%d", *host, *port)
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	displayHost := *host
	if displayHost == "0.0.0.0" {
		if h, err := os.Hostname(); err == nil {
			displayHost = h
		}
	}
	log.Printf("daw-here listening on http://%s:%d", displayHost, *port)
	log.Printf("serving sessions from: %s", absRoot)
	if err := httpSrv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

// ---- handlers ----

func (s *server) serveIndex(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(s.indexHTML)
}

func (s *server) serveSessionsAPI(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.listSessions())
}

func (s *server) serveSessionHTML(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if _, ok := s.resolveSession(name); !ok {
		http.NotFound(w, r)
		return
	}
	body := strings.ReplaceAll(s.sessionTmpl, "__SESSION_NAME__", html.EscapeString(name))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write([]byte(body))
}

func (s *server) serveSessionAPI(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	dir, ok := s.resolveSession(name)
	if !ok {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, map[string]any{
		"name":   name,
		"tracks": s.listTracks(dir),
	})
}

func (s *server) serveAudio(w http.ResponseWriter, r *http.Request) {
	sessionName := r.PathValue("session")
	relPath := r.PathValue("path")

	sessionDir, ok := s.resolveSession(sessionName)
	if !ok {
		http.NotFound(w, r)
		return
	}

	target := filepath.Clean(filepath.Join(sessionDir, relPath))
	rel, err := filepath.Rel(sessionDir, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}

	if ct, ok := audioExts[strings.ToLower(filepath.Ext(target))]; ok {
		w.Header().Set("Content-Type", ct)
	}

	file, err := os.Open(target)
	if err != nil {
		http.Error(w, "io error", http.StatusInternalServerError)
		return
	}
	defer file.Close()

	// ServeContent handles Range, conditional GETs, and Content-Length.
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

// ---- session listing ----

func (s *server) listSessions() []SessionMeta {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return []SessionMeta{}
	}
	out := make([]SessionMeta, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(s.root, e.Name())
		tracks := s.listTracks(dir)
		if len(tracks) == 0 {
			continue
		}
		out = append(out, SessionMeta{
			Name:       e.Name(),
			TrackCount: len(tracks),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

// listTracks descends through redundant single-directory wrappers (common in
// Cambridge MT zips) before walking the contained tree for audio files.
func (s *server) listTracks(sessionDir string) []Track {
	contentRoot := sessionDir
	for i := 0; i < 4; i++ {
		visible, err := readVisible(contentRoot)
		if err != nil {
			break
		}
		if len(visible) == 1 && visible[0].IsDir() {
			contentRoot = filepath.Join(contentRoot, visible[0].Name())
			continue
		}
		break
	}

	tracks := []Track{}
	sessionBase := filepath.Base(sessionDir)
	filepath.WalkDir(contentRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		base := d.Name()
		if strings.HasPrefix(base, "._") || base == ".DS_Store" {
			return nil
		}
		if _, ok := audioExts[strings.ToLower(filepath.Ext(base))]; !ok {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		display, _ := filepath.Rel(contentRoot, path)
		display = filepath.ToSlash(display)
		urlRel, _ := filepath.Rel(sessionDir, path)
		urlRel = filepath.ToSlash(urlRel)
		tracks = append(tracks, Track{
			Name: display,
			URL:  "/audio/" + url.PathEscape(sessionBase) + "/" + escapePathSegments(urlRel),
			Size: info.Size(),
		})
		return nil
	})

	sort.Slice(tracks, func(i, j int) bool {
		return strings.ToLower(tracks[i].Name) < strings.ToLower(tracks[j].Name)
	})
	return tracks
}

// ---- helpers ----

func (s *server) resolveSession(name string) (string, bool) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\") {
		return "", false
	}
	target, err := filepath.Abs(filepath.Join(s.root, name))
	if err != nil {
		return "", false
	}
	rootAbs, err := filepath.Abs(s.root)
	if err != nil {
		return "", false
	}
	if target != rootAbs && !strings.HasPrefix(target, rootAbs+string(filepath.Separator)) {
		return "", false
	}
	info, err := os.Stat(target)
	if err != nil || !info.IsDir() {
		return "", false
	}
	return target, true
}

func readVisible(dir string) ([]fs.DirEntry, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]fs.DirEntry, 0, len(entries))
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, "._") || n == ".DS_Store" {
			continue
		}
		out = append(out, e)
	}
	return out, nil
}

// escapePathSegments URL-encodes each "/"-separated segment but preserves the
// separators themselves so the resulting path keeps its directory structure.
func escapePathSegments(p string) string {
	parts := strings.Split(p, "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return strings.Join(parts, "/")
}

func writeJSON(w http.ResponseWriter, obj any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(obj)
}
