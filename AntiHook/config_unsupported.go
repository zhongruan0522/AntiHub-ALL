//go:build !windows && !darwin
// +build !windows,!darwin

package main

import "fmt"

func persistUserEnvVar(key, value string) error {
	return fmt.Errorf("persist env var is not supported on this platform: %s", key)
}
