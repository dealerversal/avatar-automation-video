// src/mcp/registry.js
import { logger } from '../utils/logger.js';

/**
 * MCP Tool Registry
 * Central registry where all browser tools are registered and retrieved.
 */
class ToolRegistry {
    constructor() {
        this._tools = new Map();
    }

    /**
     * Register a tool instance
     * @param {BaseTool} toolInstance - An instance of a class extending BaseTool
     */
    register(toolInstance) {
        if (!toolInstance.name || !toolInstance.description || !toolInstance.execute) {
            throw new Error(`Invalid tool: must have name, description, and execute()`);
        }
        this._tools.set(toolInstance.name, toolInstance);
        logger.info(`[Registry] Registered tool: "${toolInstance.name}"`);
    }

    /**
     * Get a tool by name
     * @param {string} name
     * @returns {BaseTool}
     */
    getTool(name) {
        const tool = this._tools.get(name);
        if (!tool) throw new Error(`Tool "${name}" not found in registry`);
        return tool;
    }

    /**
     * Get all registered tools as OpenAI function-calling definitions
     * @returns {Array}
     */
    getAllFunctionDefs() {
        return Array.from(this._tools.values()).map((t) => t.toFunctionDef());
    }

    /**
     * Get list of all tool names
     * @returns {string[]}
     */
    getToolNames() {
        return Array.from(this._tools.keys());
    }
}

// Singleton instance
export const registry = new ToolRegistry();
