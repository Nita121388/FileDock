package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/crypto/ssh/knownhosts"
)

// This plugin implements a minimal SFTP filesystem connector for FileDock.
//
// Contract:
// - reads a single JSON document from stdin
// - writes a single JSON document to stdout
//
// Exit codes:
// - 0: request was handled (ok=true or ok=false)
// - non-zero: internal error (invalid input, etc.)

type request struct {
	Op   string          `json:"op"`
	Conn connConfig      `json:"conn"`
	Args json.RawMessage `json:"args"`
}

type connConfig struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	User string `json:"user"`

	Auth       authConfig       `json:"auth"`
	KnownHosts knownHostsConfig `json:"known_hosts"`

	// Optional base path prefix (chroot-ish UX). If set, all incoming paths are joined under it.
	BasePath string `json:"base_path"`
}

type authConfig struct {
	// One of password/key_path/agent should be set.
	Password string `json:"password"`
	KeyPath  string `json:"key_path"`
	Agent    bool   `json:"agent"`
}

type knownHostsConfig struct {
	// "strict" (default), "accept-new", or "insecure"
	Policy string `json:"policy"`
	// optional known_hosts file path (defaults to ~/.ssh/known_hosts)
	Path string `json:"path"`
}

type response struct {
	OK    bool        `json:"ok"`
	Data  interface{} `json:"data,omitempty"`
	Error *respError  `json:"error,omitempty"`
}

type respError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func main() {
	in, err := io.ReadAll(os.Stdin)
	if err != nil {
		writeAndExit(2, response{OK: false, Error: &respError{Code: "read_stdin", Message: err.Error()}})
	}

	in = bytes.TrimSpace(in)
	if len(in) == 0 {
		writeAndExit(2, response{OK: false, Error: &respError{Code: "empty_input", Message: "stdin is empty"}})
	}

	var req request
	if err := json.Unmarshal(in, &req); err != nil {
		writeAndExit(2, response{OK: false, Error: &respError{Code: "invalid_json", Message: err.Error()}})
	}

	req.Op = strings.TrimSpace(req.Op)
	if req.Op == "" {
		writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_request", Message: "missing op"}})
	}

	if req.Conn.Port == 0 {
		req.Conn.Port = 22
	}
	req.Conn.Host = strings.TrimSpace(req.Conn.Host)
	req.Conn.User = strings.TrimSpace(req.Conn.User)
	if req.Conn.Host == "" || req.Conn.User == "" {
		writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_request", Message: "missing conn.host or conn.user"}})
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	client, sftpClient, err := dialSFTP(ctx, &req.Conn)
	if err != nil {
		writeAndExit(0, response{OK: false, Error: classifyErr(err)})
	}
	defer client.Close()
	defer sftpClient.Close()

	switch req.Op {
	case "list":
		var a struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(req.Args, &a); err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_args", Message: err.Error()}})
		}
		p, err := sanitizeRemotePath(req.Conn.BasePath, a.Path)
		if err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_args", Message: err.Error()}})
		}
		ents, err := sftpClient.ReadDir(p)
		if err != nil {
			writeAndExit(0, response{OK: false, Error: classifyErr(err)})
		}
		type entry struct {
			Name      string `json:"name"`
			Kind      string `json:"kind"` // file|dir|other
			Size      int64  `json:"size,omitempty"`
			MtimeUnix int64  `json:"mtime_unix,omitempty"`
		}
		out := make([]entry, 0, len(ents))
		for _, e := range ents {
			k := "other"
			if e.IsDir() {
				k = "dir"
			} else if e.Mode().IsRegular() {
				k = "file"
			}
			out = append(out, entry{
				Name:      e.Name(),
				Kind:      k,
				Size:      e.Size(),
				MtimeUnix: e.ModTime().Unix(),
			})
		}
		writeAndExit(0, response{OK: true, Data: map[string]interface{}{"entries": out}})

	case "stat":
		var a struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(req.Args, &a); err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_args", Message: err.Error()}})
		}
		p, err := sanitizeRemotePath(req.Conn.BasePath, a.Path)
		if err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_args", Message: err.Error()}})
		}
		st, err := sftpClient.Stat(p)
		if err != nil {
			writeAndExit(0, response{OK: false, Error: classifyErr(err)})
		}
		kind := "other"
		if st.IsDir() {
			kind = "dir"
		} else if st.Mode().IsRegular() {
			kind = "file"
		}
		writeAndExit(0, response{OK: true, Data: map[string]interface{}{
			"kind":       kind,
			"size":       st.Size(),
			"mtime_unix": st.ModTime().Unix(),
		}})

	case "download":
		var a struct {
			RemotePath string `json:"remote_path"`
			LocalPath  string `json:"local_path"`
		}
		if err := json.Unmarshal(req.Args, &a); err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_args", Message: err.Error()}})
		}
		rp, err := sanitizeRemotePath(req.Conn.BasePath, a.RemotePath)
		if err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_args", Message: err.Error()}})
		}
		if strings.TrimSpace(a.LocalPath) == "" {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_args", Message: "missing local_path"}})
		}

		if err := os.MkdirAll(path.Dir(a.LocalPath), 0o755); err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "io", Message: err.Error()}})
		}
		src, err := sftpClient.Open(rp)
		if err != nil {
			writeAndExit(0, response{OK: false, Error: classifyErr(err)})
		}
		defer src.Close()
		dst, err := os.Create(a.LocalPath)
		if err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "io", Message: err.Error()}})
		}
		defer dst.Close()
		n, err := io.Copy(dst, src)
		if err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "io", Message: err.Error()}})
		}
		writeAndExit(0, response{OK: true, Data: map[string]interface{}{"bytes_written": n}})

	case "upload":
		var a struct {
			LocalPath  string `json:"local_path"`
			RemotePath string `json:"remote_path"`
			Mkdirs     bool   `json:"mkdirs"`
		}
		if err := json.Unmarshal(req.Args, &a); err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_args", Message: err.Error()}})
		}
		if strings.TrimSpace(a.LocalPath) == "" || strings.TrimSpace(a.RemotePath) == "" {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_args", Message: "missing local_path or remote_path"}})
		}
		rp, err := sanitizeRemotePath(req.Conn.BasePath, a.RemotePath)
		if err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_args", Message: err.Error()}})
		}

		src, err := os.Open(a.LocalPath)
		if err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "io", Message: err.Error()}})
		}
		defer src.Close()

		if a.Mkdirs {
			if err := sftpClient.MkdirAll(path.Dir(rp)); err != nil {
				writeAndExit(0, response{OK: false, Error: classifyErr(err)})
			}
		}

		dst, err := sftpClient.Create(rp)
		if err != nil {
			writeAndExit(0, response{OK: false, Error: classifyErr(err)})
		}
		defer dst.Close()

		n, err := io.Copy(dst, src)
		if err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "io", Message: err.Error()}})
		}
		writeAndExit(0, response{OK: true, Data: map[string]interface{}{"bytes_written": n}})

	case "mkdir":
		var a struct {
			Path    string `json:"path"`
			Parents bool   `json:"parents"`
		}
		if err := json.Unmarshal(req.Args, &a); err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_args", Message: err.Error()}})
		}
		rp, err := sanitizeRemotePath(req.Conn.BasePath, a.Path)
		if err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_args", Message: err.Error()}})
		}
		if a.Parents {
			err = sftpClient.MkdirAll(rp)
		} else {
			err = sftpClient.Mkdir(rp)
		}
		if err != nil {
			writeAndExit(0, response{OK: false, Error: classifyErr(err)})
		}
		writeAndExit(0, response{OK: true})

	case "mv":
		var a struct {
			From string `json:"from"`
			To   string `json:"to"`
		}
		if err := json.Unmarshal(req.Args, &a); err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_args", Message: err.Error()}})
		}
		from, err := sanitizeRemotePath(req.Conn.BasePath, a.From)
		if err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_args", Message: err.Error()}})
		}
		to, err := sanitizeRemotePath(req.Conn.BasePath, a.To)
		if err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_args", Message: err.Error()}})
		}
		if err := sftpClient.Rename(from, to); err != nil {
			writeAndExit(0, response{OK: false, Error: classifyErr(err)})
		}
		writeAndExit(0, response{OK: true})

	case "rm":
		var a struct {
			Path      string `json:"path"`
			Recursive bool   `json:"recursive"`
		}
		if err := json.Unmarshal(req.Args, &a); err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_args", Message: err.Error()}})
		}
		if a.Recursive {
			// Dangerous; keep it explicit and unimplemented for MVP.
			writeAndExit(0, response{OK: false, Error: &respError{Code: "unsupported", Message: "recursive delete is not supported (set recursive=false)"}})
		}
		rp, err := sanitizeRemotePath(req.Conn.BasePath, a.Path)
		if err != nil {
			writeAndExit(0, response{OK: false, Error: &respError{Code: "bad_args", Message: err.Error()}})
		}
		st, err := sftpClient.Stat(rp)
		if err != nil {
			writeAndExit(0, response{OK: false, Error: classifyErr(err)})
		}
		if st.IsDir() {
			if err := sftpClient.RemoveDirectory(rp); err != nil {
				writeAndExit(0, response{OK: false, Error: classifyErr(err)})
			}
		} else {
			if err := sftpClient.Remove(rp); err != nil {
				writeAndExit(0, response{OK: false, Error: classifyErr(err)})
			}
		}
		writeAndExit(0, response{OK: true})

	default:
		writeAndExit(0, response{OK: false, Error: &respError{Code: "unsupported", Message: "unknown op"}})
	}
}

func writeAndExit(code int, resp response) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(resp)
	os.Exit(code)
}

func classifyErr(err error) *respError {
	if err == nil {
		return &respError{Code: "unknown", Message: "unknown error"}
	}
	msg := err.Error()

	// Normalize common errors.
	if errors.Is(err, os.ErrNotExist) {
		return &respError{Code: "not_found", Message: msg}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &respError{Code: "timeout", Message: msg}
	}
	if strings.Contains(strings.ToLower(msg), "permission denied") {
		return &respError{Code: "permission_denied", Message: msg}
	}
	if strings.Contains(strings.ToLower(msg), "no such file") {
		return &respError{Code: "not_found", Message: msg}
	}
	return &respError{Code: "error", Message: msg}
}

func sanitizeRemotePath(base, p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		p = "."
	}
	if strings.Contains(p, "\x00") {
		return "", fmt.Errorf("invalid path")
	}

	// Normalize to clean POSIX path.
	p = path.Clean(p)

	// Apply base path (if any).
	base = strings.TrimSpace(base)
	if base != "" {
		base = path.Clean(base)
		if base == "." {
			base = ""
		}
		if base != "" {
			p = path.Join(base, p)
		}
	}

	// Prevent accidental traversal out of base path.
	if base != "" {
		b := base
		if !strings.HasSuffix(b, "/") {
			b = b + "/"
		}
		if p != base && !strings.HasPrefix(p, b) {
			return "", fmt.Errorf("path escapes base_path")
		}
	}

	return p, nil
}

func dialSFTP(ctx context.Context, cfg *connConfig) (*ssh.Client, *sftp.Client, error) {
	am, err := authMethods(cfg)
	if err != nil {
		return nil, nil, err
	}

	hkcb, err := hostKeyCallback(cfg)
	if err != nil {
		return nil, nil, err
	}

	sshConf := &ssh.ClientConfig{
		User:            cfg.User,
		Auth:            am,
		HostKeyCallback: hkcb,
		Timeout:         30 * time.Second,
	}

	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)

	var d net.Dialer
	netConn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, nil, err
	}

	c, chans, reqs, err := ssh.NewClientConn(netConn, addr, sshConf)
	if err != nil {
		_ = netConn.Close()
		return nil, nil, err
	}
	client := ssh.NewClient(c, chans, reqs)

	sftpClient, err := sftp.NewClient(client)
	if err != nil {
		_ = client.Close()
		return nil, nil, err
	}
	return client, sftpClient, nil
}

func authMethods(cfg *connConfig) ([]ssh.AuthMethod, error) {
	var out []ssh.AuthMethod

	if strings.TrimSpace(cfg.Auth.Password) != "" {
		out = append(out, ssh.Password(cfg.Auth.Password))
	}

	if strings.TrimSpace(cfg.Auth.KeyPath) != "" {
		keyPath := cfg.Auth.KeyPath
		if strings.HasPrefix(keyPath, "~") {
			home, _ := os.UserHomeDir()
			keyPath = strings.Replace(keyPath, "~", home, 1)
		}
		keyPath = filepath.Clean(keyPath)
		key, err := os.ReadFile(keyPath)
		if err != nil {
			return nil, fmt.Errorf("read key: %w", err)
		}
		signer, err := ssh.ParsePrivateKey(key)
		if err != nil {
			return nil, fmt.Errorf("parse key: %w", err)
		}
		out = append(out, ssh.PublicKeys(signer))
	}

	if cfg.Auth.Agent {
		sock := os.Getenv("SSH_AUTH_SOCK")
		if sock == "" {
			return nil, fmt.Errorf("SSH_AUTH_SOCK not set (agent requested)")
		}
		conn, err := net.Dial("unix", sock)
		if err != nil {
			return nil, fmt.Errorf("dial ssh agent: %w", err)
		}
		ag := agent.NewClient(conn)
		out = append(out, ssh.PublicKeysCallback(ag.Signers))
	}

	if len(out) == 0 {
		return nil, fmt.Errorf("no auth method configured (set conn.auth.password or conn.auth.key_path or conn.auth.agent)")
	}
	return out, nil
}

func hostKeyCallback(cfg *connConfig) (ssh.HostKeyCallback, error) {
	policy := strings.TrimSpace(cfg.KnownHosts.Policy)
	if policy == "" {
		policy = "strict"
	}
	switch policy {
	case "insecure":
		return ssh.InsecureIgnoreHostKey(), nil
	case "strict", "accept-new":
	default:
		return nil, fmt.Errorf("invalid known_hosts.policy: %s", policy)
	}

	kp := strings.TrimSpace(cfg.KnownHosts.Path)
	if kp == "" {
		home, _ := os.UserHomeDir()
		kp = filepath.Join(home, ".ssh", "known_hosts")
	}
	kp = filepath.Clean(kp)

	cb, err := knownhosts.New(kp)
	if err != nil {
		// Create directory if needed, then try again.
		_ = os.MkdirAll(filepath.Dir(kp), 0o700)
		cb, err = knownhosts.New(kp)
		if err != nil {
			return nil, err
		}
	}

	if policy == "strict" {
		return cb, nil
	}

	// accept-new: if host is unknown, append it to known_hosts and accept.
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		err := cb(hostname, remote, key)
		var ke *knownhosts.KeyError
		if errors.As(err, &ke) {
			// Unknown host: Want is empty.
			if len(ke.Want) == 0 {
				line := knownhosts.Line([]string{hostname}, key)
				// Ensure file exists.
				if err := os.MkdirAll(filepath.Dir(kp), 0o700); err != nil {
					return err
				}
				f, err := os.OpenFile(kp, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
				if err != nil {
					return err
				}
				defer f.Close()
				if _, err := f.WriteString(line + "\n"); err != nil {
					return err
				}
				return nil
			}
			// Host key mismatch.
			return err
		}
		return err
	}, nil
}
