package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type AppConfig struct {
	KiroServerURL string `json:"kiro_server_url"`
}

func configDir() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("failed to get home directory: %w", err)
	}
	return filepath.Join(homeDir, ".config", "antihook"), nil
}

func configFilePath() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

func loadConfig() (*AppConfig, error) {
	path, err := configFilePath()
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var cfg AppConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}

	return &cfg, nil
}

func saveConfig(cfg *AppConfig) error {
	if cfg == nil {
		return errors.New("config is nil")
	}

	kiroURL, err := normalizeBaseURL(cfg.KiroServerURL)
	if err != nil {
		return fmt.Errorf("invalid kiro_server_url: %w", err)
	}

	dir, err := configDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create config dir: %w", err)
	}

	path, err := configFilePath()
	if err != nil {
		return err
	}

	normalized := &AppConfig{
		KiroServerURL: kiroURL,
	}

	data, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to serialize config: %w", err)
	}
	data = append(data, '\n')

	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0600); err != nil {
		return fmt.Errorf("failed to write temp config: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to write config: %w", err)
	}

	return nil
}

func hasCompleteUserConfig() bool {
	_, err := resolveKiroServerURL()
	return err == nil
}

func resolveKiroServerURL() (string, error) {
	if v := strings.TrimSpace(os.Getenv("KIRO_SERVER_URL")); v != "" {
		return normalizeBaseURL(v)
	}

	cfg, err := loadConfig()
	if err == nil && cfg.KiroServerURL != "" {
		return normalizeBaseURL(cfg.KiroServerURL)
	}

	if strings.TrimSpace(DefaultServerURL) == "" {
		return "", errors.New("缺少配置：请运行 `antihook --config` 或设置 KIRO_SERVER_URL")
	}

	return normalizeBaseURL(DefaultServerURL)
}

func normalizeBaseURL(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	s = strings.TrimRight(s, "/")
	if s == "" {
		return "", errors.New("empty url")
	}

	parsed, err := url.Parse(s)
	if err != nil {
		return "", fmt.Errorf("invalid url: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("unsupported scheme: %s", parsed.Scheme)
	}
	if parsed.Host == "" {
		return "", errors.New("missing host")
	}
	return s, nil
}

func isInteractiveStdin() bool {
	info, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return (info.Mode() & os.ModeCharDevice) != 0
}

func maybeRunFirstRunConfig() error {
	if hasCompleteUserConfig() {
		return nil
	}
	if !isInteractiveStdin() {
		return errors.New("缺少配置：请在终端运行 `antihook --config`，或在用户环境变量中设置 KIRO_SERVER_URL")
	}
	return runConfigWizard("首次运行")
}

func runConfigWizard(reason string) error {
	reader := bufio.NewReader(os.Stdin)

	fmt.Printf("AntiHook %s配置：\n", reason)
	fmt.Println("直接回车表示使用默认值（为空则必须输入）。")
	fmt.Println("")

	defaultKiro := ""
	if v := strings.TrimSpace(os.Getenv("KIRO_SERVER_URL")); v != "" {
		defaultKiro = v
	}

	if cfg, err := loadConfig(); err == nil {
		if cfg.KiroServerURL != "" {
			defaultKiro = cfg.KiroServerURL
		}
	}

	kiroURL, err := promptBaseURL(reader, "AntiHub 服务地址 (KIRO_SERVER_URL)", defaultKiro)
	if err != nil {
		return err
	}

	cfg := &AppConfig{
		KiroServerURL: kiroURL,
	}
	if err := saveConfig(cfg); err != nil {
		return err
	}

	writeEnv, err := promptYesNo(reader, "是否同时写入用户环境变量（可选）", false)
	if err != nil {
		return err
	}
	if writeEnv {
		if err := persistUserEnvVar("KIRO_SERVER_URL", kiroURL); err != nil {
			return err
		}
		_ = os.Setenv("KIRO_SERVER_URL", kiroURL)
	}

	if path, err := configFilePath(); err == nil {
		fmt.Printf("\n配置已保存：%s\n", path)
	}
	return nil
}

func promptBaseURL(reader *bufio.Reader, label, defaultValue string) (string, error) {
	for {
		fmt.Printf("%s [%s]: ", label, strings.TrimSpace(defaultValue))
		line, err := readLine(reader)
		if err != nil {
			return "", err
		}
		if line == "" {
			line = defaultValue
		}
		normalized, err := normalizeBaseURL(line)
		if err != nil {
			fmt.Printf("无效地址：%v\n", err)
			continue
		}
		return normalized, nil
	}
}

func promptYesNo(reader *bufio.Reader, label string, defaultYes bool) (bool, error) {
	def := "N"
	if defaultYes {
		def = "Y"
	}

	for {
		fmt.Printf("%s [Y/N] (默认 %s): ", label, def)
		line, err := readLine(reader)
		if err != nil {
			return false, err
		}
		line = strings.ToLower(strings.TrimSpace(line))

		if line == "" {
			return defaultYes, nil
		}
		if line == "y" || line == "yes" {
			return true, nil
		}
		if line == "n" || line == "no" {
			return false, nil
		}

		fmt.Println("请输入 Y 或 N。")
	}
}

func readLine(reader *bufio.Reader) (string, error) {
	line, err := reader.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return strings.TrimSpace(line), nil
}

