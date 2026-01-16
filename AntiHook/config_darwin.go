//go:build darwin
// +build darwin

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func persistUserEnvVar(key, value string) error {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("failed to get home directory: %w", err)
	}

	shell := os.Getenv("SHELL")
	var rcFile string
	if filepath.Base(shell) == "zsh" {
		rcFile = filepath.Join(homeDir, ".zshrc")
	} else {
		rcFile = filepath.Join(homeDir, ".bash_profile")
	}

	line := fmt.Sprintf("export %s=%q", key, value)

	content, err := os.ReadFile(rcFile)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to read rc file: %w", err)
	}

	lines := []string{}
	if len(content) > 0 {
		lines = strings.Split(string(content), "\n")
	}

	found := false
	for i := 0; i < len(lines); i++ {
		if strings.HasPrefix(strings.TrimSpace(lines[i]), "export "+key+"=") {
			lines[i] = line
			found = true
		}
	}

	if !found {
		if len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) != "" {
			lines = append(lines, "")
		}
		lines = append(lines, "# Added by AntiHook (config)")
		lines = append(lines, line)
	}

	out := strings.Join(lines, "\n")
	if !strings.HasSuffix(out, "\n") {
		out += "\n"
	}

	if err := os.WriteFile(rcFile, []byte(out), 0644); err != nil {
		return fmt.Errorf("failed to write rc file: %w", err)
	}

	return nil
}
