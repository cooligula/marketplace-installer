const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// --- Helper Functions ---

/**
 * Gets the platform-specific path to the python executable in the venv.
 * @param {string} venvPath - The path to the virtual environment directory.
 * @returns {string} The path to the pip executable.
 */
function getPythonCommand(venvPath) {
    return process.platform === 'win32'
        ? path.join(venvPath, 'Scripts', 'python.exe')
        : path.join(venvPath, 'bin', 'python');
}

/**
 * Gets the platform-specific path to the vsix-to-vscodium executable in the venv.
 * @param {string} venvPath - The path to the virtual environment directory.
 * @returns {string} The path to the executable.
 */
function getInstallerCommand(venvPath) {
    return process.platform === 'win32'
        ? path.join(venvPath, 'Scripts', 'vsix-to-vscodium.exe')
        : path.join(venvPath, 'bin', 'vsix-to-vscodium');
}

/**
 * Executes a shell command and returns a promise.
 * @param {string} command - The command to execute.
 * @param {object} [options] - Options for child_process.exec.
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function execPromise(command, options) {
    return new Promise((resolve, reject) => {
        exec(command, options, (error, stdout, stderr) => {
            if (error) {
                // Also include stderr in the rejection for more context
                error.message += `\n${stderr}`;
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

/**
 * Checks for a valid python command (python3 or python).
 * @returns {Promise<string>} The valid python command.
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
 * Ensures the Python virtual environment and dependencies are set up.
 * @param {string} storagePath - The path to the extension's global storage.
 * @returns {Promise<string>} The path to the vsix-to-vscodium executable.
 */
async function ensureDependencies(storagePath) {
    const venvPath = path.join(storagePath, '.venv');
    const installerPath = getInstallerCommand(venvPath);

    if (fs.existsSync(installerPath)) {
        console.log('Dependencies are already installed.');
        return installerPath;
    }

    // If not installed, show a progress notification for the one-time setup.
    return await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Setting up Python environment for Marketplace Installer...',
        cancellable: false
    }, async (progress) => {
        try {
            // 1. Find a valid python command
            const pythonCmd = await findPython();
            
            // 2. Create the virtual environment
            progress.report({ message: 'Creating virtual environment...' });
            await execPromise(`${pythonCmd} -m venv ${venvPath}`);

            // 3. Install the package using the venv's pip
            progress.report({ message: 'Installing vsix-to-vscodium...' });
            const venvPython = getPythonCommand(venvPath);
            await execPromise(`"${venvPython}" -m pip install vsix-to-vscodium`);

            vscode.window.showInformationMessage('Marketplace Installer setup complete!');
            return installerPath;

        } catch (error) {
            vscode.window.showErrorMessage(`Failed to set up Python dependencies: ${error.message}`);
            // Re-throw the error to be caught by the calling function.
            throw error;
        }
    });
}


// --- Activation ---

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
    // Get the global storage path, which is a persistent location for this extension.
    const storagePath = context.globalStorageUri.fsPath;
    if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
    }

    // We will run the setup on activation, but lazily. The actual installation
    // will only happen when the command is first run. We store the promise.
    let dependencySetupPromise = ensureDependencies(storagePath);
    
    // Handle cases where the setup fails initially.
    dependencySetupPromise.catch(err => {
        console.error("Initial dependency check failed.", err);
        // Allow the user to retry by re-running the command.
        dependencySetupPromise = null; 
    });

    let disposable = vscode.commands.registerCommand('marketplace-installer.installExtension', async function () {
        try {
            // If the initial setup failed, try again.
            if (!dependencySetupPromise) {
                 dependencySetupPromise = ensureDependencies(storagePath);
            }
            // Wait for the setup to complete and get the path to the executable.
            const installerCmd = await dependencySetupPromise;

            const extensionId = await vscode.window.showInputBox({
                prompt: 'Enter the Visual Studio Marketplace extension ID',
                placeHolder: 'e.g., publisher.extension-name (like ms-python.python)',
                validateInput: text => /^[a-z0-9-]+\.[a-z0-9-]+$/i.test(text) ? null : 'Invalid format. Use "publisher.extension-name".'
            });

            if (!extensionId) {
                vscode.window.showInformationMessage('Installation cancelled.');
                return;
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Installing "${extensionId}"...`,
                cancellable: false
            }, async () => {
                try {
                    // Use the full path to the executable from our venv
                    const command = `"${installerCmd}" ${extensionId}`;
                    const { stdout, stderr } = await execPromise(command);
                    
                    if (stderr) {
                        // Log warnings but don't necessarily fail
                        console.warn(`Installation produced warnings: ${stderr}`);
                    }
                    console.log(`stdout: ${stdout}`);
                    
                    vscode.window.showInformationMessage(
                        `Successfully installed "${extensionId}"! Please reload to activate.`,
                        'Reload Window'
                    ).then(selection => {
                        if (selection === 'Reload Window') {
                            vscode.commands.executeCommand('workbench.action.reloadWindow');
                        }
                    });

                } catch (error) {
                    vscode.window.showErrorMessage(`Installation Failed: ${error.message}`);
                }
            });

        } catch (error) {
            // This catches errors from ensureDependencies if it fails.
            vscode.window.showErrorMessage(`Could not run installer: ${error.message}`);
        }
    });

    context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
}
