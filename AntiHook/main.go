package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	protocolRegistry "antihook/registry"
)

const (
	ProtocolDescription = "Kiro Protocol Handler"
	TargetDirName       = "Antihub"
)

// 这些变量可以在编译时通过 -ldflags 注入
var (
	DefaultServerURL = ""
	BuildVersion     = "dev"
	BuildTime        = "unknown"
)

func init() {
	// 环境变量优先级最高
	if url := os.Getenv("KIRO_SERVER_URL"); url != "" {
		DefaultServerURL = url
	}
}

func main() {
	recoverFlag := flag.Bool("recover", false, "Restore original Kiro protocol handler")
	configFlag := flag.Bool("config", false, "Run configuration wizard and exit")
	printConfigPathFlag := flag.Bool("print-config-path", false, "Print config file path and exit")
	flag.Parse()

	if *recoverFlag {
		if err := recoverOriginal(); err != nil {
			showMessageBox("Error", "Recovery failed: "+err.Error(), 0x10)
			os.Exit(1)
		}
		showMessageBox("Success", "Protocol handler restored!", 0x40)
		return
	}

	if *printConfigPathFlag {
		path, err := configFilePath()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println(path)
		return
	}

	if *configFlag {
		if err := runConfigWizard("手动"); err != nil {
			showMessageBox("Error", "Config failed: "+err.Error(), 0x10)
			os.Exit(1)
		}
		return
	}

	args := flag.Args()
	if len(args) > 0 {
		lowerArg := strings.ToLower(args[0])
		if strings.HasPrefix(lowerArg, "kiro://") {
			handleProtocolCall(args[0])
			return
		}
	}

	if err := maybeRunFirstRunConfig(); err != nil {
		showMessageBox("Error", "Config failed: "+err.Error(), 0x10)
		os.Exit(1)
	}

	if err := install(); err != nil {
		showMessageBox("Error", "Installation failed: "+err.Error(), 0x10)
		os.Exit(1)
	}

	showMessageBox("Success", "Hooked successfully!", 0x40)
}

func install() error {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("failed to get home directory: %w", err)
	}

	targetDir := filepath.Join(homeDir, ".local", "bin", TargetDirName)
	targetPath := filepath.Join(targetDir, "antihook")

	currentPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to get current executable path: %w", err)
	}
	currentPath, _ = filepath.Abs(currentPath)

	if !strings.EqualFold(currentPath, targetPath) {
		if err := os.MkdirAll(targetDir, 0755); err != nil {
			return fmt.Errorf("failed to create target directory: %w", err)
		}

		if _, err := os.Stat(targetPath); err == nil {
			if err := os.Remove(targetPath); err != nil {
				return fmt.Errorf("failed to remove old file: %w", err)
			}
		}

		if err := copyFile(currentPath, targetPath); err != nil {
			return fmt.Errorf("failed to copy file: %w", err)
		}

		// 确保可执行权限
		if err := os.Chmod(targetPath, 0755); err != nil {
			return fmt.Errorf("failed to set executable permission: %w", err)
		}
	}

	kiroHandler := &protocolRegistry.ProtocolHandler{
		Protocol:    protocolRegistry.ProtocolName,
		ExePath:     targetPath,
		Description: ProtocolDescription,
	}

	if err := kiroHandler.Register(); err != nil {
		return fmt.Errorf("failed to register kiro protocol: %w", err)
	}

	if err := addToPath(targetDir); err != nil {
		fmt.Printf("Warning: failed to add to PATH: %v\n", err)
	}

	return nil
}

func copyFile(src, dst string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	dstFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer dstFile.Close()

	if _, err := io.Copy(dstFile, srcFile); err != nil {
		return err
	}

	return dstFile.Sync()
}

func handleProtocolCall(rawURL string) {
	homeDir, _ := os.UserHomeDir()
	logFile, err := os.OpenFile(filepath.Join(homeDir, ".config", "antihook", "kiro.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err == nil {
		defer logFile.Close()
		logFile.WriteString(fmt.Sprintf("\n=== %s ===\n", time.Now().Format("2006-01-02 15:04:05")))
		logFile.WriteString(fmt.Sprintf("Received kiro:// callback: %s\n", rawURL))
	}

	fmt.Printf("Received kiro:// callback: %s\n", rawURL)

	if err := postCallback(rawURL); err != nil {
		errMsg := fmt.Sprintf("Login failed: %v\n", err)
		fmt.Printf(errMsg)
		if logFile != nil {
			logFile.WriteString(errMsg)
		}
		showMessageBox("Error", "Login failed: "+err.Error(), 0x10)
		return
	}

	successMsg := "Login successful!\n"
	fmt.Printf(successMsg)
	if logFile != nil {
		logFile.WriteString(successMsg)
	}
	showMessageBox("Success", "Login successful!", 0x40)
}

func postCallback(callbackURL string) error {
	homeDir, _ := os.UserHomeDir()
	logFile, _ := os.OpenFile(filepath.Join(homeDir, ".config", "antihook", "kiro.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if logFile != nil {
		defer logFile.Close()
	}

	requestBody := map[string]string{
		"callback_url": callbackURL,
	}

	jsonData, err := json.Marshal(requestBody)
	if err != nil {
		return fmt.Errorf("failed to serialize request body: %w", err)
	}

	serverURL, err := resolveKiroServerURL()
	if err != nil {
		return err
	}

	apiURL := serverURL + "/api/kiro/oauth/callback"

	logMsg := fmt.Sprintf("Posting to: %s\n", apiURL)
	fmt.Printf(logMsg)
	if logFile != nil {
		logFile.WriteString(logMsg)
	}

	logMsg = fmt.Sprintf("Request body: %s\n", string(jsonData))
	fmt.Printf(logMsg)
	if logFile != nil {
		logFile.WriteString(logMsg)
	}

	resp, err := http.Post(
		apiURL,
		"application/json",
		bytes.NewBuffer(jsonData),
	)
	if err != nil {
		errMsg := fmt.Sprintf("HTTP request failed: %v\n", err)
		if logFile != nil {
			logFile.WriteString(errMsg)
		}
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	logMsg = fmt.Sprintf("Response status: %d\n", resp.StatusCode)
	fmt.Printf(logMsg)
	if logFile != nil {
		logFile.WriteString(logMsg)
	}

	logMsg = fmt.Sprintf("Response body: %s\n", string(body))
	fmt.Printf(logMsg)
	if logFile != nil {
		logFile.WriteString(logMsg)
	}

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("server returned error: %d, %s", resp.StatusCode, string(body))
	}

	return nil
}

