//go:build windows
// +build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows/registry"
)

func persistUserEnvVar(keyName, value string) error {
	key, err := registry.OpenKey(registry.CURRENT_USER, `Environment`, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("failed to open Environment key: %w", err)
	}
	defer key.Close()

	if err := key.SetStringValue(keyName, value); err != nil {
		return fmt.Errorf("failed to set %s: %w", keyName, err)
	}

	// Best-effort: broadcast env change so new processes can see it without reboot.
	broadcastEnvironmentChange()
	return nil
}

func broadcastEnvironmentChange() {
	const (
		hwndBroadcast   = 0xffff
		wmSettingChange = 0x001A
		smtoAbortIfHung = 0x0002
	)

	user32 := syscall.NewLazyDLL("user32.dll")
	sendMessageTimeout := user32.NewProc("SendMessageTimeoutW")

	envPtr, _ := syscall.UTF16PtrFromString("Environment")
	var result uintptr
	sendMessageTimeout.Call(
		uintptr(hwndBroadcast),
		uintptr(wmSettingChange),
		0,
		uintptr(unsafe.Pointer(envPtr)),
		uintptr(smtoAbortIfHung),
		5000,
		uintptr(unsafe.Pointer(&result)),
	)
}
