//go:build windows

package main

import "golang.org/x/crypto/ssh"

func startResizeWatcher(_ *ssh.Session, _ int) {}
