package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/crypto/ssh/knownhosts"
)

type config struct {
	Conn connConfig `json:"conn"`
	Cwd  string     `json:"cwd"`
	Cols int        `json:"cols"`
	Rows int        `json:"rows"`
	Term string     `json:"term"`
}

type connConfig struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	User string `json:"user"`

	Auth       authConfig       `json:"auth"`
	KnownHosts knownHostsConfig `json:"known_hosts"`
	BasePath   string           `json:"base_path"`
}

type authConfig struct {
	Password string `json:"password"`
	KeyPath  string `json:"key_path"`
	Agent    bool   `json:"agent"`
}

type knownHostsConfig struct {
	Policy string `json:"policy"`
	Path   string `json:"path"`
}

func main() {
	var cfgB64 string
	flag.StringVar(&cfgB64, "config-b64", "", "base64-encoded JSON config")
	flag.Parse()

	if strings.TrimSpace(cfgB64) == "" {
		fmt.Fprintln(os.Stderr, "missing --config-b64")
		os.Exit(2)
	}

	decoded, err := base64.StdEncoding.DecodeString(cfgB64)
	if err != nil {
		fmt.Fprintln(os.Stderr, "decode config:", err)
		os.Exit(2)
	}

	var cfg config
	if err := json.Unmarshal(decoded, &cfg); err != nil {
		fmt.Fprintln(os.Stderr, "parse config:", err)
		os.Exit(2)
	}

	cfg.Conn.Host = strings.TrimSpace(cfg.Conn.Host)
	cfg.Conn.User = strings.TrimSpace(cfg.Conn.User)
	if cfg.Conn.Port == 0 {
		cfg.Conn.Port = 22
	}
	if cfg.Conn.Host == "" || cfg.Conn.User == "" {
		fmt.Fprintln(os.Stderr, "missing conn.host or conn.user")
		os.Exit(2)
	}
	if cfg.Term == "" {
		cfg.Term = "xterm-256color"
	}
	if cfg.Cols <= 0 {
		cfg.Cols = 80
	}
	if cfg.Rows <= 0 {
		cfg.Rows = 24
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	client, err := dialSSH(ctx, &cfg.Conn)
	if err != nil {
		fmt.Fprintln(os.Stderr, "ssh connect:", err)
		os.Exit(1)
	}
	defer client.Close()

	session, err := client.NewSession()
	if err != nil {
		fmt.Fprintln(os.Stderr, "ssh session:", err)
		os.Exit(1)
	}
	defer session.Close()

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := session.RequestPty(cfg.Term, cfg.Rows, cfg.Cols, modes); err != nil {
		fmt.Fprintln(os.Stderr, "request pty:", err)
		os.Exit(1)
	}

	session.Stdout = os.Stdout
	session.Stderr = os.Stdout
	session.Stdin = os.Stdin

	startResizeWatcher(session, int(os.Stdout.Fd()))

	cmd := buildRemoteCommand(cfg.Conn.BasePath, cfg.Cwd)
	if cmd == "" {
		if err := session.Shell(); err != nil {
			fmt.Fprintln(os.Stderr, "start shell:", err)
			os.Exit(1)
		}
		if err := session.Wait(); err != nil {
			fmt.Fprintln(os.Stderr, "shell error:", err)
			os.Exit(1)
		}
		return
	}

	if err := session.Run(cmd); err != nil {
		fmt.Fprintln(os.Stderr, "session error:", err)
		os.Exit(1)
	}
}

func buildRemoteCommand(basePath, cwd string) string {
	cwd = strings.TrimSpace(cwd)
	if cwd == "" {
		return "exec ${SHELL:-/bin/sh} -l"
	}
	p, err := sanitizeRemotePath(basePath, cwd)
	if err != nil {
		return "exec ${SHELL:-/bin/sh} -l"
	}
	if p == "." || p == "" {
		return "exec ${SHELL:-/bin/sh} -l"
	}
	return fmt.Sprintf("cd %s 2>/dev/null || cd ~; exec ${SHELL:-/bin/sh} -l", shellEscape(p))
}

func shellEscape(s string) string {
	if s == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

func sanitizeRemotePath(base, p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		p = "."
	}
	if strings.Contains(p, "\x00") {
		return "", fmt.Errorf("invalid path")
	}

	p = path.Clean(p)

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

func dialSSH(ctx context.Context, cfg *connConfig) (*ssh.Client, error) {
	am, err := authMethods(cfg)
	if err != nil {
		return nil, err
	}

	hkcb, err := hostKeyCallback(cfg)
	if err != nil {
		return nil, err
	}

	sshConf := &ssh.ClientConfig{
		User:            cfg.User,
		Auth:            am,
		HostKeyCallback: hkcb,
		Timeout:         30 * time.Second,
	}

	addr := net.JoinHostPort(cfg.Host, fmt.Sprintf("%d", cfg.Port))
	var d net.Dialer
	netConn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}

	c, chans, reqs, err := ssh.NewClientConn(netConn, addr, sshConf)
	if err != nil {
		_ = netConn.Close()
		return nil, err
	}

	return ssh.NewClient(c, chans, reqs), nil
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
		_ = os.MkdirAll(filepath.Dir(kp), 0o700)
		cb, err = knownhosts.New(kp)
		if err != nil {
			return nil, err
		}
	}

	if policy == "strict" {
		return cb, nil
	}

	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		err := cb(hostname, remote, key)
		var ke *knownhosts.KeyError
		if errors.As(err, &ke) {
			if len(ke.Want) == 0 {
				line := knownhosts.Line([]string{hostname}, key)
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
			return err
		}
		return err
	}, nil
}
