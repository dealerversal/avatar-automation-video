// src/mcp/baseTool.js

/**
 * Abstract base class for all MCP browser tools.
 * Every tool must extend this and implement the required properties/methods.
 */
export class BaseTool {
    /**
     * @returns {string} Unique tool name (snake_case)
     */
    get name() {
        throw new Error(`Tool "${this.constructor.name}" must implement get name()`);
    }

    /**
     * @returns {string} Human-readable description of what this tool does.
     * This is sent to the AI agent so it can decide when to use the tool.
     */
    get description() {
        throw new Error(`Tool "${this.constructor.name}" must implement get description()`);
    }

    /**
     * @returns {object} JSON Schema for the tool's input arguments
     */
    get inputSchema() {
        throw new Error(`Tool "${this.constructor.name}" must implement get inputSchema()`);
    }

    /**
     * Execute the tool with the given arguments
     * @param {object} args - Arguments matching the inputSchema
     * @returns {Promise<object>} Structured result object
     */
    async execute(args) {
        throw new Error(`Tool "${this.constructor.name}" must implement execute(args)`);
    }

    /**
     * Returns the OpenAI function-calling compatible tool definition
     * for passing to the AI agent
     */
    toFunctionDef() {
        return {
            type: 'function',
            function: {
                name: this.name,
                description: this.description,
                parameters: this.inputSchema,
            },
        };
    }
}
