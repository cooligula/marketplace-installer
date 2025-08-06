const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
// MarketplaceViewProvider is still required here
const { MarketplaceViewProvider } = require('./MarketplaceViewProvider');

// --- Helper Functions ---

/**
 * Determines the correct Python executable path within a virtual environment.
 * @param {string} venvPath The path to the virtual environment.
 * @returns {string} The full path to the Python executable.
 */
function getPythonCommand(venvPath) {
    return process.platform === 'win32' ?
        path.join(venvPath, 'Scripts', 'python.exe') :
        path.join(venvPath, 'bin', 'python');
}

/**
 * Determines the correct vsix-to-vscodium installer executable path within a virtual environment.
 * @param {string} venvPath The path to the virtual environment.
 * @returns {string} The full path to the installer executable.
 */
function getInstallerCommand(venvPath) {
    return process.platform === 'win32' ?
        path.join(venvPath, 'Scripts', 'vsix-to-vscodium.exe') :
        path.join(venvPath, 'bin', 'vsix-to-vscodium');
}

/**
 * Executes a shell command and returns a Promise.
 * @param {string} command The command to execute.
 * @param {import('child_process').ExecOptions} [options] Options for the child process.
 * @returns {Promise<{stdout: string, stderr: string}>} A promise that resolves with stdout/stderr or rejects with an error.
 */
function execPromise(command, options) {
    return new Promise((resolve, reject) => {
        exec(command, options, (error, stdout, stderr) => {
            if (error) {
                // Append stderr to error message for better debugging
                error.message += `\n${stderr}`;
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

/**
 * Finds the correct Python command ('python3' or 'python') available on the system.
 * @returns {Promise<string>} A promise that resolves with the Python command.
 * @throws {Error} If Python is not found.
 */
async function findPython() {
    try {
        await execPromise('python3 --version');
        return 'python3';
    } catch (err) {
        try {
            await execPromise('python --version');
            return 'python';
        } catch (err2) {
            throw new Error('Python is not installed or not in your PATH. Please install Python to use this extension.');
        }
    }
}

/**
 * Ensures that the Python virtual environment and `vsix-to-vscodium` are set up.
 * This runs as a progress notification.
 * @param {string} storagePath The global storage path for the extension.
 * @returns {Promise<string>} A promise that resolves with the path to the installer command.
 */
async function ensureDependencies(storagePath) {
    const venvPath = path.join(storagePath, '.venv');
    const installerPath = getInstallerCommand(venvPath);

    // Check if installer already exists to avoid unnecessary setup
    if (fs.existsSync(installerPath)) {
        console.log('vsix-to-vscodium already installed.');
        return installerPath;
    }

    return await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Setting up Marketplace Installer dependencies...',
        cancellable: false // User cannot cancel this essential setup
    }, async (progress) => {
        try {
            const pythonCmd = await findPython();
            progress.report({ message: 'Creating Python virtual environment...' });
            // Create virtual environment
            await execPromise(`${pythonCmd} -m venv "${venvPath}"`);

            progress.report({ message: 'Installing vsix-to-vscodium tool...' });
            const venvPython = getPythonCommand(venvPath);
            // Install vsix-to-vscodium into the virtual environment
            await execPromise(`"${venvPython}" -m pip install vsix-to-vscodium`);

            vscode.window.showInformationMessage('Marketplace Installer setup complete! You can now search and install extensions.');
            return installerPath;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to set up Python dependencies: ${error.message}`);
            // Re-throw the error so the promise chain can handle it
            throw error;
        }
    });
}

/**
 * The core installation logic for a VS Code extension using vsix-to-vscodium.
 * This function is called from both the command palette and the webview.
 * @param {string} extensionId The full ID of the extension to install (e.g., 'publisher.extension-name').
 * @param {string} installerCmd The path to the vsix-to-vscodium executable.
 */
async function installExtension(extensionId, installerCmd) {
    if (!extensionId || !installerCmd) {
        vscode.window.showErrorMessage('Installation failed: Missing extension ID or installer command path.');
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Installing "${extensionId}"...`,
        cancellable: false
    }, async () => {
        try {
            // Execute the vsix-to-vscodium install command
            // Corrected command: Removed 'install' keyword based on user feedback
            const command = `"${installerCmd}" ${extensionId}`;
            console.log(`Executing installation command: ${command}`); // Debugging
            const { stdout, stderr } = await execPromise(command);

            if (stderr) {
                console.warn(`Installation produced warnings/errors: ${stderr}`);
            }
            console.log(`Installation stdout: ${stdout}`); // Debugging

            vscode.window.showInformationMessage(
                `Successfully installed "${extensionId}"! Please reload your Codium window to activate the extension.`,
                'Reload Window' // Button text
            ).then(selection => {
                if (selection === 'Reload Window') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });

        } catch (error) {
            console.error(`Error during installation of ${extensionId}:`, error); // Debugging
            vscode.window.showErrorMessage(`Installation Failed for "${extensionId}": ${error.message}`);
        }
    });
}


// --- Extension Activation ---

/**
 * Called when the extension is activated.
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
    console.log('Marketplace Installer extension is activating...');

    // Ensure the global storage directory exists for the virtual environment
    const storagePath = context.globalStorageUri.fsPath;
    if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
        console.log(`Created storage directory: ${storagePath}`);
    }

    // Start the dependency setup. This promise will resolve with the installer command path.
    // The view provider will await this promise before attempting installations.
    let dependencySetupPromise = ensureDependencies(storagePath);

    // Create and register the sidebar webview view provider
    // Pass the installExtension function directly to the provider
    const provider = new MarketplaceViewProvider(context.extensionUri, dependencySetupPromise, installExtension);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider("marketplace-installer.view", provider)
    );
    console.log('MarketplaceViewProvider registered.');

    // Register a command palette command as an alternative way to install
    context.subscriptions.push(vscode.commands.registerCommand('marketplace-installer.installFromInput', async () => {
        try {
            const installerCmd = await dependencySetupPromise; // Await the installer path
            const extensionId = await vscode.window.showInputBox({
                prompt: 'Enter the Visual Studio Marketplace extension ID',
                placeHolder: 'e.g., publisher.extension-name'
            });
            if (extensionId) {
                await installExtension(extensionId, installerCmd);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Could not run installer: ${error.message}`);
            console.error('Error from installFromInput command:', error);
        }
    }));
    console.log('Command "marketplace-installer.installFromInput" registered.');
}

/**
 * Called when the extension is deactivated.
 */
function deactivate() {
    console.log('Marketplace Installer extension deactivated.');
}

// Export functions for VS Code to use
module.exports = {
    activate,
    deactivate,
    installExtension // Exported for potential direct use or testing
};
