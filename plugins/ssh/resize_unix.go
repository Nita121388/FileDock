//go:build !windows

package main

import (
	"os"
	"os/signal"
	"syscall"

	"golang.org/x/crypto/ssh"
	"golang.org/x/term"
)

func startResizeWatcher(session *ssh.Session, fd int) {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGWINCH)
	go func() {
		for range ch {
			cols, rows, err := term.GetSize(fd)
			if err != nil {
				continue
			}
			_ = session.WindowChange(rows, cols)
		}
	}()
}
