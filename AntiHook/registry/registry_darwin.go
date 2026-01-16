// +build darwin

package registry

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	ProtocolName   = "kiro"
	ProtocolScheme = "kiro://"
)

type ProtocolHandler struct {
	Protocol    string
	ExePath     string
	Description string
}

func NewProtocolHandler(protocol, description string) (*ProtocolHandler, error) {
	exePath, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("failed to get executable path: %w", err)
	}

	exePath, err = filepath.Abs(exePath)
	if err != nil {
		return nil, fmt.Errorf("failed to get absolute path: %w", err)
	}

	return &ProtocolHandler{
		Protocol:    protocol,
		ExePath:     exePath,
		Description: description,
	}, nil
}

func (h *ProtocolHandler) Register() error {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("failed to get home directory: %w", err)
	}

	// 创建存储目录
	configDir := filepath.Join(homeDir, ".config", "antihook")
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	// 创建 AppleScript 来处理协议
	scriptPath := filepath.Join(configDir, fmt.Sprintf("%s_handler.scpt", h.Protocol))
	scriptContent := fmt.Sprintf(`on open location this_URL
    do shell script "%s " & quoted form of this_URL
end open location`, h.ExePath)

	if err := os.WriteFile(scriptPath, []byte(scriptContent), 0755); err != nil {
		return fmt.Errorf("failed to write AppleScript: %w", err)
	}

	appPath := strings.TrimSuffix(scriptPath, ".scpt") + ".app"

	// 编译 AppleScript
	cmd := exec.Command("osacompile", "-o", appPath, scriptPath)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to compile AppleScript: %w", err)
	}

	// 创建 Info.plist 为应用添加 bundle identifier 和 URL scheme
	infoPlistPath := filepath.Join(appPath, "Contents", "Info.plist")
	bundleID := fmt.Sprintf("com.antihook.%s-handler", h.Protocol)

	plistContent, err := os.ReadFile(infoPlistPath)
	if err != nil {
		return fmt.Errorf("failed to read Info.plist: %w", err)
	}

	// 在 </dict> 前添加 CFBundleIdentifier 和 CFBundleURLTypes
	plistStr := string(plistContent)
	insertPos := strings.LastIndex(plistStr, "</dict>")
	if insertPos == -1 {
		return fmt.Errorf("invalid Info.plist format")
	}

	addition := fmt.Sprintf(`	<key>CFBundleIdentifier</key>
	<string>%s</string>
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLName</key>
			<string>%s URL</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>%s</string>
			</array>
		</dict>
	</array>
`, bundleID, h.Description, h.Protocol)

	newPlistContent := plistStr[:insertPos] + addition + plistStr[insertPos:]

	if err := os.WriteFile(infoPlistPath, []byte(newPlistContent), 0644); err != nil {
		return fmt.Errorf("failed to write Info.plist: %w", err)
	}

	// 重置 LaunchServices 数据库以识别新的应用
	cmd = exec.Command("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-f", appPath)
	if err := cmd.Run(); err != nil {
		fmt.Printf("Warning: failed to register with LaunchServices: %v\n", err)
	}

	// 使用 duti 设置为默认处理器
	cmd = exec.Command("duti", "-s", bundleID, h.Protocol, "all")
	if err := cmd.Run(); err != nil {
		// 如果 duti 失败，尝试使用 open 命令注册
		fmt.Printf("Warning: duti failed, trying alternative method: %v\n", err)

		testURL := fmt.Sprintf("%s://test", h.Protocol)
		cmd = exec.Command("open", "-a", appPath, testURL)
		_ = cmd.Run() // 忽略错误
	}

	fmt.Printf("Protocol handler registered for '%s://'\n", h.Protocol)
	fmt.Printf("  Handler app: %s\n", appPath)
	fmt.Printf("  Bundle ID: %s\n", bundleID)
	fmt.Printf("\nPlease restart your browser for changes to take effect.\n")

	return nil
}

func (h *ProtocolHandler) Unregister() error {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("failed to get home directory: %w", err)
	}

	configDir := filepath.Join(homeDir, ".config", "antihook")
	scriptPath := filepath.Join(configDir, fmt.Sprintf("%s_handler", h.Protocol))

	// 删除 AppleScript 应用
	if err := os.RemoveAll(scriptPath + ".app"); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove handler app: %w", err)
	}

	// 删除脚本文件
	if err := os.Remove(scriptPath + ".scpt"); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove script: %w", err)
	}

	return nil
}

func (h *ProtocolHandler) IsRegistered() (bool, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return false, fmt.Errorf("failed to get home directory: %w", err)
	}

	scriptPath := filepath.Join(homeDir, ".config", "antihook", fmt.Sprintf("%s_handler.app", h.Protocol))
	_, err = os.Stat(scriptPath)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("failed to check registration: %w", err)
	}

	return true, nil
}

func (h *ProtocolHandler) GetRegisteredHandler() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("failed to get home directory: %w", err)
	}

	scriptPath := filepath.Join(homeDir, ".config", "antihook", fmt.Sprintf("%s_handler.app", h.Protocol))
	return scriptPath, nil
}

func (h *ProtocolHandler) Backup() (map[string]string, error) {
	// macOS 不需要备份，因为我们创建的是新的处理器
	return nil, nil
}

func (h *ProtocolHandler) Restore(backup map[string]string) error {
	// macOS 上只需要注销即可
	return h.Unregister()
}

func (h *ProtocolHandler) IsSelfRegistered() (bool, error) {
	return h.IsRegistered()
}
