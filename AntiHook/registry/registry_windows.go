// +build windows

package registry

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows/registry"
)

const (
	ProtocolName     = "kiro"
	ProtocolScheme   = "kiro://"
	RegistryBasePath = `Software\Classes`
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

func (h *ProtocolHandler) getKeyPath(subPath string) string {
	if subPath == "" {
		return RegistryBasePath + `\` + h.Protocol
	}
	return RegistryBasePath + `\` + h.Protocol + `\` + subPath
}

func (h *ProtocolHandler) Register() error {
	keyPath := h.getKeyPath("")
	key, _, err := registry.CreateKey(registry.CURRENT_USER, keyPath, registry.ALL_ACCESS)
	if err != nil {
		return fmt.Errorf("failed to create registry key %s: %w", keyPath, err)
	}
	defer key.Close()

	if err := key.SetStringValue("", h.Description); err != nil {
		return fmt.Errorf("failed to set protocol description: %w", err)
	}

	if err := key.SetStringValue("URL Protocol", ""); err != nil {
		return fmt.Errorf("failed to set URL Protocol marker: %w", err)
	}

	cmdKeyPath := h.getKeyPath(`shell\open\command`)
	cmdKey, _, err := registry.CreateKey(registry.CURRENT_USER, cmdKeyPath, registry.ALL_ACCESS)
	if err != nil {
		return fmt.Errorf("failed to create command key %s: %w", cmdKeyPath, err)
	}
	defer cmdKey.Close()

	command := fmt.Sprintf(`"%s" "%%1"`, h.ExePath)
	if err := cmdKey.SetStringValue("", command); err != nil {
		return fmt.Errorf("failed to set command: %w", err)
	}

	iconKeyPath := h.getKeyPath(`DefaultIcon`)
	iconKey, _, err := registry.CreateKey(registry.CURRENT_USER, iconKeyPath, registry.ALL_ACCESS)
	if err != nil {
		fmt.Printf("Warning: failed to create icon key: %v\n", err)
	} else {
		defer iconKey.Close()
		iconValue := fmt.Sprintf(`"%s",0`, h.ExePath)
		if err := iconKey.SetStringValue("", iconValue); err != nil {
			fmt.Printf("Warning: failed to set icon: %v\n", err)
		}
	}

	return nil
}

func (h *ProtocolHandler) Unregister() error {
	subKeys := []string{
		`shell\open\command`,
		`shell\open`,
		`shell`,
		`DefaultIcon`,
	}

	for _, subKey := range subKeys {
		keyPath := h.getKeyPath(subKey)
		err := registry.DeleteKey(registry.CURRENT_USER, keyPath)
		if err != nil && err != registry.ErrNotExist {
			if subKey != `DefaultIcon` {
				return fmt.Errorf("failed to delete %s key: %w", subKey, err)
			}
		}
	}

	keyPath := h.getKeyPath("")
	err := registry.DeleteKey(registry.CURRENT_USER, keyPath)
	if err != nil && err != registry.ErrNotExist {
		return fmt.Errorf("failed to delete protocol key: %w", err)
	}

	return nil
}

func (h *ProtocolHandler) IsRegistered() (bool, error) {
	keyPath := h.getKeyPath("")
	key, err := registry.OpenKey(registry.CURRENT_USER, keyPath, registry.QUERY_VALUE)
	if err == registry.ErrNotExist {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("failed to check registry: %w", err)
	}
	defer key.Close()

	_, _, err = key.GetStringValue("URL Protocol")
	if err == registry.ErrNotExist {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("failed to read URL Protocol: %w", err)
	}

	return true, nil
}

func (h *ProtocolHandler) GetRegisteredHandler() (string, error) {
	cmdKeyPath := h.getKeyPath(`shell\open\command`)
	key, err := registry.OpenKey(registry.CURRENT_USER, cmdKeyPath, registry.QUERY_VALUE)
	if err != nil {
		return "", fmt.Errorf("failed to open command key: %w", err)
	}
	defer key.Close()

	command, _, err := key.GetStringValue("")
	if err != nil {
		return "", fmt.Errorf("failed to read command: %w", err)
	}

	return command, nil
}

func (h *ProtocolHandler) Backup() (map[string]string, error) {
	backup := make(map[string]string)

	keyPath := h.getKeyPath("")
	key, err := registry.OpenKey(registry.CURRENT_USER, keyPath, registry.QUERY_VALUE)
	if err == registry.ErrNotExist {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to open protocol key: %w", err)
	}
	defer key.Close()

	desc, _, err := key.GetStringValue("")
	if err == nil {
		backup["description"] = desc
	}

	cmdKeyPath := h.getKeyPath(`shell\open\command`)
	cmdKey, err := registry.OpenKey(registry.CURRENT_USER, cmdKeyPath, registry.QUERY_VALUE)
	if err == nil {
		defer cmdKey.Close()
		cmd, _, err := cmdKey.GetStringValue("")
		if err == nil {
			backup["command"] = cmd
		}
	}

	return backup, nil
}

func (h *ProtocolHandler) Restore(backup map[string]string) error {
	if backup == nil || len(backup) == 0 {
		return h.Unregister()
	}

	keyPath := h.getKeyPath("")
	key, _, err := registry.CreateKey(registry.CURRENT_USER, keyPath, registry.ALL_ACCESS)
	if err != nil {
		return fmt.Errorf("failed to create protocol key: %w", err)
	}
	defer key.Close()

	if desc, ok := backup["description"]; ok {
		if err := key.SetStringValue("", desc); err != nil {
			return fmt.Errorf("failed to restore description: %w", err)
		}
	}

	if err := key.SetStringValue("URL Protocol", ""); err != nil {
		return fmt.Errorf("failed to set URL Protocol: %w", err)
	}

	if cmd, ok := backup["command"]; ok {
		cmdKeyPath := h.getKeyPath(`shell\open\command`)
		cmdKey, _, err := registry.CreateKey(registry.CURRENT_USER, cmdKeyPath, registry.ALL_ACCESS)
		if err != nil {
			return fmt.Errorf("failed to create command key: %w", err)
		}
		defer cmdKey.Close()

		if err := cmdKey.SetStringValue("", cmd); err != nil {
			return fmt.Errorf("failed to restore command: %w", err)
		}
	}

	return nil
}

func (h *ProtocolHandler) IsSelfRegistered() (bool, error) {
	registered, err := h.IsRegistered()
	if err != nil {
		return false, err
	}
	if !registered {
		return false, nil
	}

	handler, err := h.GetRegisteredHandler()
	if err != nil {
		return false, err
	}

	return containsPath(handler, h.ExePath), nil
}

func containsPath(command, path string) bool {
	return containsIgnoreCase(command, path)
}

func containsIgnoreCase(s, substr string) bool {
	s = toLower(s)
	substr = toLower(substr)
	return contains(s, substr)
}

func toLower(s string) string {
	result := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		result[i] = c
	}
	return string(result)
}

func contains(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

