/**
 * CMUX Terminal Adapter
 * 
 * Implements the TerminalAdapter interface for CMUX (cmux.dev).
 */

import { TerminalAdapter, SpawnOptions, execCommand } from "../utils/terminal-adapter";

export class CmuxAdapter implements TerminalAdapter {
  readonly name = "cmux";

  detect(): boolean {
    // Check for CMUX specific environment variables
    return !!process.env.CMUX_SOCKET_PATH || !!process.env.CMUX_WORKSPACE_ID;
  }

  spawn(options: SpawnOptions): string {
    // We use new-split to create a new pane in CMUX.
    // CMUX doesn't have a direct 'spawn' that returns a pane ID and runs a command 
    // in one go while also returning the ID in a way we can easily capture for 'isAlive'.
    // However, 'new-split' returns the new surface ID.
    
    // Construct the command with environment variables
    const envPrefix = Object.entries(options.env)
      .filter(([k]) => k.startsWith("PI_"))
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    
    const fullCommand = envPrefix ? `env ${envPrefix} ${options.command}` : options.command;

    // CMUX new-split returns "OK <UUID>"
    const splitResult = execCommand("cmux", ["new-split", "right", "--command", fullCommand]);
    
    if (splitResult.status !== 0) {
      throw new Error(`cmux new-split failed with status ${splitResult.status}: ${splitResult.stderr}`);
    }

    const output = splitResult.stdout.trim();
    if (output.startsWith("OK ")) {
      const surfaceId = output.substring(3).trim();
      return surfaceId;
    }

    throw new Error(`cmux new-split returned unexpected output: ${output}`);
  }

  kill(paneId: string): void {
    if (!paneId) return;
    
    try {
      // CMUX calls them surfaces
      execCommand("cmux", ["close-surface", "--surface", paneId]);
    } catch {
      // Ignore errors during kill
    }
  }

  isAlive(paneId: string): boolean {
    if (!paneId) return false;

    try {
      // We can use list-pane-surfaces and grep for the ID
      // Or just 'identify' if we want to be precise, but list-pane-surfaces is safer
      const result = execCommand("cmux", ["list-pane-surfaces"]);
      return result.stdout.includes(paneId);
    } catch {
      return false;
    }
  }

  setTitle(title: string): void {
    try {
      // rename-tab or rename-workspace? 
      // Usually agents want to rename their current "tab" or "surface"
      execCommand("cmux", ["rename-tab", title]);
    } catch {
      // Ignore errors
    }
  }

  /**
   * CMUX supports spawning separate OS windows
   */
  supportsWindows(): boolean {
    return true;
  }

  /**
   * Spawn a new separate OS window.
   */
  spawnWindow(options: SpawnOptions): string {
    // CMUX new-window returns "OK <UUID>"
    const result = execCommand("cmux", ["new-window"]);
    
    if (result.status !== 0) {
      throw new Error(`cmux new-window failed with status ${result.status}: ${result.stderr}`);
    }

    const output = result.stdout.trim();
    if (output.startsWith("OK ")) {
      const windowId = output.substring(3).trim();
      
      // Now we need to run the command in this window.
      // Usually new-window creates a default workspace/surface.
      // We might need to find the workspace in that window.
      
      // For now, let's just use 'new-workspace' in that window if possible, 
      // but CMUX commands usually target the current window unless specified.
      // Wait a bit for the window to be ready?
      
      const envPrefix = Object.entries(options.env)
        .filter(([k]) => k.startsWith("PI_"))
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      
      const fullCommand = envPrefix ? `env ${envPrefix} ${options.command}` : options.command;

      // Target the new window
      execCommand("cmux", ["new-workspace", "--window", windowId, "--command", fullCommand]);

      if (options.teamName) {
        this.setWindowTitle(windowId, options.teamName);
      }

      return windowId;
    }

    throw new Error(`cmux new-window returned unexpected output: ${output}`);
  }

  /**
   * Set the title of a specific window.
   */
  setWindowTitle(windowId: string, title: string): void {
    try {
      execCommand("cmux", ["rename-window", "--window", windowId, title]);
    } catch {
      // Ignore
    }
  }

  /**
   * Kill/terminate a window.
   */
  killWindow(windowId: string): void {
    if (!windowId) return;
    try {
      execCommand("cmux", ["close-window", "--window", windowId]);
    } catch {
      // Ignore
    }
  }

  /**
   * Check if a window is still alive.
   */
  isWindowAlive(windowId: string): boolean {
    if (!windowId) return false;
    try {
      const result = execCommand("cmux", ["list-windows"]);
      return result.stdout.includes(windowId);
    } catch {
      return false;
    }
  }

  /**
   * Custom CMUX capability: create a workspace for a problem.
   * This isn't part of the TerminalAdapter interface but can be used via the adapter.
   */
  createProblemWorkspace(title: string, command?: string): string {
    const args = ["new-workspace"];
    if (command) {
      args.push("--command", command);
    }
    
    const result = execCommand("cmux", args);
    if (result.status !== 0) {
      throw new Error(`cmux new-workspace failed: ${result.stderr}`);
    }
    
    const output = result.stdout.trim();
    if (output.startsWith("OK ")) {
      const workspaceId = output.substring(3).trim();
      execCommand("cmux", ["workspace-action", "--action", "rename", "--title", title, "--workspace", workspaceId]);
      return workspaceId;
    }
    
    throw new Error(`cmux new-workspace returned unexpected output: ${output}`);
  }
}
