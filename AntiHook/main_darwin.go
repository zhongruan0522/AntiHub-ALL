// +build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func showMessageBox(title, message string, flags uint) {
	// macOS 使用 osascript 显示对话框
	script := fmt.Sprintf(`display dialog "%s" with title "%s" buttons {"OK"} default button "OK"`, message, title)
	cmd := exec.Command("osascript", "-e", script)
	cmd.Run()
}

func addToPath(dir string) error {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("failed to get home directory: %w", err)
	}

	// 检查使用的 shell
	shell := os.Getenv("SHELL")
	var rcFile string

	if filepath.Base(shell) == "zsh" {
		rcFile = filepath.Join(homeDir, ".zshrc")
	} else {
		rcFile = filepath.Join(homeDir, ".bash_profile")
	}

	// 读取现有内容
	content, err := os.ReadFile(rcFile)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to read rc file: %w", err)
	}

	pathLine := fmt.Sprintf("\n# Added by AntiHook\nexport PATH=\"%s:$PATH\"\n", dir)

	// 检查是否已经添加
	if len(content) > 0 && containsString(string(content), dir) {
		return nil
	}

	// 追加到文件
	f, err := os.OpenFile(rcFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("failed to open rc file: %w", err)
	}
	defer f.Close()

	if _, err := f.WriteString(pathLine); err != nil {
		return fmt.Errorf("failed to write to rc file: %w", err)
	}

	fmt.Printf("Added to PATH in %s. Please run: source %s\n", rcFile, rcFile)
	return nil
}

func containsString(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > len(substr) &&
		(s[:len(substr)] == substr || s[len(s)-len(substr):] == substr ||
			findSubstring(s, substr)))
}

func findSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func recoverOriginal() error {
	return fmt.Errorf("recover is only supported on Windows")
}

