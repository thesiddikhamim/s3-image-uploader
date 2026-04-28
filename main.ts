import {
	App,
	Editor,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TextComponent,
	setIcon,
	RequestUrlParam,
	requestUrl,
	TFile,
	MarkdownView,
	Modal,
	ButtonComponent,
} from "obsidian";
import { HttpRequest, HttpResponse } from "@aws-sdk/protocol-http";
import { HttpHandlerOptions } from "@aws-sdk/types";
import { buildQueryString } from "@aws-sdk/querystring-builder";
import { requestTimeout } from "@smithy/fetch-http-handler/dist-es/request-timeout";

import {
	FetchHttpHandler,
	FetchHttpHandlerOptions,
} from "@smithy/fetch-http-handler";

import { filesize } from "filesize";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import imageCompression from "browser-image-compression";
import { minimatch } from "minimatch";

// Remember to rename these classes and interfaces!!

interface pasteFunction {
	(
		this: HTMLElement,
		event: ClipboardEvent | DragEvent,
		editor: Editor,
	): void;
}

interface S3UploaderSettings {
	accessKey: string;
	secretKey: string;
	region: string;
	bucket: string;
	folder: string;
	imageUrlPath: string;
	uploadOnDrag: boolean;
	useCustomEndpoint: boolean;
	customEndpoint: string;
	forcePathStyle: boolean;
	useCustomImageUrl: boolean;
	customImageUrl: string;
	uploadVideo: boolean;
	uploadAudio: boolean;
	uploadPdf: boolean;
	bypassCors: boolean;
	queryStringValue: string;
	queryStringKey: string;
	enableImageCompression: boolean;
	maxImageCompressionSize: number;
	imageCompressionQuality: number;
	maxImageWidthOrHeight: number;
	ignorePattern: string;
	disableAutoUploadOnCreate: boolean;
	askRename: boolean;
}

const DEFAULT_SETTINGS: S3UploaderSettings = {
	accessKey: "",
	secretKey: "",
	region: "",
	bucket: "",
	folder: "",
	imageUrlPath: "",
	uploadOnDrag: true,
	useCustomEndpoint: false,
	customEndpoint: "",
	forcePathStyle: false,
	useCustomImageUrl: false,
	customImageUrl: "",
	uploadVideo: false,
	uploadAudio: false,
	uploadPdf: false,
	bypassCors: false,
	queryStringValue: "",
	queryStringKey: "",
	enableImageCompression: false,
	maxImageCompressionSize: 1,
	imageCompressionQuality: 0.7,
	maxImageWidthOrHeight: 4096,
	ignorePattern: "",
	disableAutoUploadOnCreate: false,
	askRename: true,
};

function sanitizeFilename(name: string): string {
	const lastDotIndex = name.lastIndexOf(".");
	const baseName =
		lastDotIndex !== -1 ? name.substring(0, lastDotIndex) : name;
	return baseName
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export default class S3UploaderPlugin extends Plugin {
	settings: S3UploaderSettings;
	s3: S3Client;
	pasteFunction: pasteFunction;

	private async replaceText(
		editor: Editor,
		target: string,
		replacement: string,
	): Promise<void> {
		const content = editor.getValue();
		const position = content.indexOf(target);

		console.log("replaceText called:", { target, replacement });

		if (position !== -1) {
			console.log("Target found at position:", position);

			// Check if we're in a table by looking for pipe characters around the target
			const surroundingBefore = content.substring(
				Math.max(0, position - 20),
				position,
			);
			const surroundingAfter = content.substring(
				position + target.length,
				Math.min(content.length, position + target.length + 20),
			);

			console.log("Surrounding text:", {
				before: surroundingBefore,
				after: surroundingAfter,
			});

			const isInTable =
				surroundingBefore.includes("|") &&
				surroundingAfter.includes("|");
			console.log("Is in table:", isInTable);

			// For tables, we need to be more careful with the replacement
			if (isInTable) {
				// Get the line containing the target
				const from = editor.offsetToPos(position);
				const to = editor.offsetToPos(position + target.length);

				console.log("Table replacement positions:", { from, to });

				try {
					// Use a more direct approach for tables
					editor.transaction({
						changes: [
							{
								from,
								to,
								text: replacement,
							},
						],
					});
					console.log("Table transaction completed");

					// Force a refresh of the editor to ensure the table renders correctly
					setTimeout(() => {
						try {
							editor.refresh();
							console.log("Editor refreshed");
						} catch (e) {
							console.error("Error refreshing editor:", e);
						}
					}, 100); // Increased timeout for better reliability
				} catch (e) {
					console.error("Error during table transaction:", e);
				}
			} else {
				// Normal replacement for non-table content
				const from = editor.offsetToPos(position);
				const to = editor.offsetToPos(position + target.length);

				console.log("Normal replacement positions:", { from, to });

				try {
					editor.transaction({
						changes: [
							{
								from,
								to,
								text: replacement,
							},
						],
					});
					console.log("Normal transaction completed");
				} catch (e) {
					console.error("Error during normal transaction:", e);
				}
			}
		} else {
			console.log("Target not found in content");
		}
	}

	private shouldIgnoreCurrentFile(filePath?: string): boolean {
		const activeFile = this.app.workspace.getActiveFile();
		const pathToCheck = filePath ?? activeFile?.path;
		if (!pathToCheck || !this.settings.ignorePattern) {
			return false;
		}
		return matchesGlobPattern(pathToCheck, this.settings.ignorePattern);
	}

	async uploadFile(file: File, key: string): Promise<string> {
		// Check if S3 client is initialized
		if (!this.s3) {
			throw new Error(
				"S3 client not configured. Please configure the plugin settings first.",
			);
		}

		const buf = await file.arrayBuffer();
		await this.s3.send(
			new PutObjectCommand({
				Bucket: this.settings.bucket,
				Key: key,
				Body: new Uint8Array(buf),
				ContentType: file.type,
			}),
		);
		let urlString = this.settings.imageUrlPath + key;
		if (this.settings.queryStringKey && this.settings.queryStringValue) {
			try {
				const urlObject = new URL(urlString);
				urlObject.searchParams.append(
					this.settings.queryStringKey,
					this.settings.queryStringValue,
				);
				urlString = urlObject.toString();
			} catch {
				// Fallback for non-absolute URL/path values.
				const separator = urlString.includes("?") ? "&" : "?";
				urlString =
					urlString +
					separator +
					encodeURIComponent(this.settings.queryStringKey) +
					"=" +
					encodeURIComponent(this.settings.queryStringValue);
			}
		}
		return urlString;
	}

	async checkFileExists(key: string, localUpload: boolean): Promise<boolean> {
		if (localUpload) {
			return await this.app.vault.adapter.exists(key);
		} else {
			if (!this.s3) return false;
			try {
				await this.s3.send(
					new HeadObjectCommand({
						Bucket: this.settings.bucket,
						Key: key,
					}),
				);
				return true;
			} catch (error) {
				if (
					error.name === "NotFound" ||
					error.$metadata?.httpStatusCode === 404
				) {
					return false;
				}
				// If it's a permission error or something else, we might want to assume it doesn't exist
				// or let the upload fail later. For now, assume it doesn't exist if we can't "head" it.
				return false;
			}
		}
	}

	async compressImage(file: File): Promise<ArrayBuffer> {
		const compressedFile = await imageCompression(file, {
			useWebWorker: false,
			maxWidthOrHeight: this.settings.maxImageWidthOrHeight,
			maxSizeMB: this.settings.maxImageCompressionSize,
			initialQuality: this.settings.imageCompressionQuality,
		});

		const fileBuffer = await compressedFile.arrayBuffer();
		const originalSize = filesize(file.size); // Input file size
		const newSize = filesize(compressedFile.size);

		new Notice(`Image compressed from ${originalSize} to ${newSize}`);

		return fileBuffer;
	}

	async pasteHandler(
		ev: ClipboardEvent | DragEvent | Event | null,
		editor: Editor,
		directFile?: File,
	): Promise<void> {
		if (ev?.defaultPrevented) {
			return;
		}

		const noteFile = this.app.workspace.getActiveFile();
		if (!noteFile || !noteFile.name) return;

		const fm = this.app.metadataCache.getFileCache(noteFile)?.frontmatter;
		// localUpload is only controlled via per-note frontmatter (localUpload: true)
		const localUpload = fm?.localUpload === true;
		const uploadVideo = fm?.uploadVideo ?? this.settings.uploadVideo;
		const uploadAudio = fm?.uploadAudio ?? this.settings.uploadAudio;
		const uploadPdf = fm?.uploadPdf ?? this.settings.uploadPdf;

		let files: File[] = [];
		if (directFile) {
			files = [directFile];
		} else if (ev) {
			switch (ev.type) {
				case "paste":
					files = Array.from(
						(ev as ClipboardEvent).clipboardData?.files || [],
					);
					break;
				case "drop":
					if (
						!this.settings.uploadOnDrag &&
						!(fm && fm.uploadOnDrag)
					) {
						return;
					}
					files = Array.from(
						(ev as DragEvent).dataTransfer?.files || [],
					);
					break;
				case "input":
					files = Array.from(
						(ev.target as HTMLInputElement).files || [],
					);
					break;
			}
		}

		// Only prevent default and proceed if we have files to handle AND file is not ignored
		if (files.length > 0) {
			// Check if uploads should be ignored for this file AFTER we know there are files
			// but BEFORE we prevent default behavior
			if (this.shouldIgnoreCurrentFile()) {
				return; // Let default Obsidian behavior handle the files
			}

			if (ev) ev.preventDefault();
			new Notice(localUpload ? "Saving files locally..." : "Uploading files...");

			// Remember cursor position before any changes
			const cursorPos = editor.getCursor();

			const validResults: string[] = [];

			for (const file of files) {
				let thisType = "";
				if (file.type.match(/video.*/) && uploadVideo) {
					thisType = "video";
				} else if (file.type.match(/audio.*/) && uploadAudio) {
					thisType = "audio";
				} else if (file.type.match(/application\/pdf/) && uploadPdf) {
					thisType = "pdf";
				} else if (file.type.match(/image.*/)) {
					thisType = "image";
				} else if (
					file.type.match(/presentation.*/) ||
					file.type.match(/powerpoint.*/)
				) {
					thisType = "ppt";
				}
				if (!thisType) {
					continue;
				}

				// Process the file
				let buf = await file.arrayBuffer();
				let newFileName = "";
				const digest = await generateFileHash(buf);
				const extension =
					file.name.lastIndexOf(".") !== -1
						? file.name.substring(file.name.lastIndexOf("."))
						: thisType === "image"
							? ".png"
							: "";

				// Use original filename or fallback to timestamp-based name
				let baseName = file.name;
				if (
					!baseName ||
					baseName === "image.png" ||
					baseName.startsWith("Pasted image") ||
					baseName === "file"
				) {
					const now = new Date();
					baseName = `${thisType}-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
				}

				const sanitized = sanitizeFilename(baseName);

				if (this.settings.askRename) {
					const renamed = await new Promise<string>((resolve) => {
						new RenameModal(this.app, sanitized, (result) => {
							resolve(result);
						}).open();
					});
					newFileName = `${renamed}${extension}`;
				} else {
					if (thisType === "image") {
						// Auto-mode for images: append hash to avoid collision
						newFileName = `${sanitized}-${digest.slice(0, 8)}${extension}`;
					} else {
						// Other files: use hash as name by default
						newFileName = `${digest}${extension}`;
					}
				}

				// Image compression (applies to S3 uploads only)
				let uploadFile = file;
				if (
					thisType === "image" &&
					this.settings.enableImageCompression &&
					!localUpload
				) {
					buf = await this.compressImage(file);
					uploadFile = new File([buf], newFileName, {
						type: file.type,
					});
				}

				if (localUpload) {
					// Save via Obsidian's native attachment API so the file
					// lands in whatever folder the user has configured in
					// Obsidian's own "Files & Links" attachment settings.
					let attachPath = "";
					try {
						attachPath = await (this.app.fileManager as any)
							.getAvailablePathForAttachment(
								newFileName,
								noteFile.path,
							);
					} catch {
						// Fallback: read Obsidian's attachmentFolderPath config
						const attachFolder =
							((this.app.vault as any).getConfig(
								"attachmentFolderPath",
							) as string) || "";
						attachPath = attachFolder
							? `${attachFolder}/${newFileName}`
							: newFileName;
					}

					// Check for existence in the vault
					const localExists =
						await this.app.vault.adapter.exists(attachPath);
					if (localExists) {
						const choice = await new Promise<
							"rename" | "overwrite" | "cancel"
						>((resolve) => {
							new ConflictModal(
								this.app,
								newFileName,
								(result) => resolve(result),
							).open();
						});
						if (choice === "cancel") {
							continue;
						} else if (choice === "rename") {
							const renamed = await new Promise<string>(
								(resolve) => {
									new RenameModal(
										this.app,
										sanitized + "-copy",
										(result) => resolve(result),
									).open();
								},
							);
							newFileName = `${renamed}${extension}`;
							try {
								attachPath =
									await (this.app.fileManager as any)
										.getAvailablePathForAttachment(
											newFileName,
											noteFile.path,
										);
							} catch {
								const attachFolder =
									((this.app.vault as any).getConfig(
										"attachmentFolderPath",
									) as string) || "";
								attachPath = attachFolder
									? `${attachFolder}/${newFileName}`
									: newFileName;
							}
						}
						// choice === "overwrite" proceeds with existing attachPath
					}

					try {
						// Write the file into Obsidian's vault at the attachment path
						await this.app.vault.adapter.writeBinary(
							attachPath,
							buf,
						);
						// Insert an Obsidian wikilink so the file is embedded normally
						const justFilename =
							attachPath.split("/").pop() ?? newFileName;
						validResults.push(`![[${justFilename}]]`);
					} catch (error) {
						console.error(error);
						validResults.push(
							`Error saving file locally: ${error.message}`,
						);
					}
				} else {
					// ── S3 / R2 upload path ──────────────────────────────────
					let folder = fm?.uploadFolder ?? this.settings.folder;

					const currentDate = new Date();
					folder = folder
						.replace("${year}", currentDate.getFullYear().toString())
						.replace(
							"${month}",
							String(currentDate.getMonth() + 1).padStart(2, "0"),
						)
						.replace(
							"${day}",
							String(currentDate.getDate()).padStart(2, "0"),
						)
						.replace(
							"${basename}",
							noteFile.basename.replace(/ /g, "-"),
						);

					let key = folder ? `${folder}/${newFileName}` : newFileName;

					// Check for existence on S3
					const exists = await this.checkFileExists(key, false);
					if (exists) {
						const choice = await new Promise<
							"rename" | "overwrite" | "cancel"
						>((resolve) => {
							new ConflictModal(
								this.app,
								newFileName,
								(result) => resolve(result),
							).open();
						});
						if (choice === "cancel") {
							continue;
						} else if (choice === "rename") {
							const renamed = await new Promise<string>(
								(resolve) => {
									new RenameModal(
										this.app,
										sanitized + "-copy",
										(result) => resolve(result),
									).open();
								},
							);
							newFileName = `${renamed}${extension}`;
							key = folder
								? `${folder}/${newFileName}`
								: newFileName;
						}
						// choice === "overwrite" proceeds
					}

					try {
						const url = await this.uploadFile(uploadFile, key);
						const markdown = wrapFileDependingOnType(url, thisType, "");
						if (markdown) {
							validResults.push(markdown);
						}
					} catch (error) {
						console.error(error);
						validResults.push(
							`Error uploading file: ${error.message}`,
						);
					}
				}
			}

			try {
				// Insert all results at once at the cursor position
				if (validResults.length > 0) {
					// Use a safer approach to insert text
					const text = validResults.join("\n");

					// Use transaction API instead of replaceSelection
					editor.transaction({
						changes: [
							{
								from: cursorPos,
								text: text,
							},
						],
					});

					new Notice(
						localUpload
							? "All files saved locally"
							: "All files uploaded successfully",
					);
				}
			} catch (error) {
				console.error("Error during upload or insertion:", error);
				new Notice(`Error: ${error.message}`);
			}
		}
	}

	createS3Client(): void {
		// Don't create S3 client if region is not configured
		if (!this.settings.region) {
			return;
		}

		const apiEndpoint = this.settings.useCustomEndpoint
			? this.settings.customEndpoint
			: `https://s3.${this.settings.region}.amazonaws.com/`;
		this.settings.imageUrlPath = this.settings.useCustomImageUrl
			? this.settings.customImageUrl
			: this.settings.forcePathStyle
				? apiEndpoint + this.settings.bucket + "/"
				: apiEndpoint.replace("://", `://${this.settings.bucket}.`);

		this.s3 = new S3Client({
			region: this.settings.region,
			credentials: {
				accessKeyId: this.settings.accessKey,
				secretAccessKey: this.settings.secretKey,
			},
			endpoint: apiEndpoint,
			forcePathStyle: this.settings.forcePathStyle,
			// Use Obsidian's requestUrl-backed handler to avoid browser fetch/CORS failures in desktop/mobile.
			requestHandler: new ObsHttpHandler(),
		});
	}

	async onload() {
		await this.loadSettings();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new S3UploaderSettingTab(this.app, this));

		this.createS3Client();

		this.addCommand({
			id: "upload-image",
			name: "Upload image",
			icon: "image-plus",
			mobileOnly: false,
			editorCallback: (editor) => {
				const input = document.createElement("input");
				input.type = "file";
				input.oninput = (event) => {
					if (!event.target) return;
					this.pasteHandler(event, editor);
				};
				input.click();
				input.remove(); // delete element
			},
		});

		this.pasteFunction = (
			event: ClipboardEvent | DragEvent,
			editor: Editor,
		) => {
			this.pasteHandler(event, editor);
		};

		this.registerEvent(
			this.app.workspace.on("editor-paste", this.pasteFunction),
		);
		this.registerEvent(
			this.app.workspace.on("editor-drop", this.pasteFunction),
		);
		// Add mobile-specific event monitoring
		this.registerEvent(
			this.app.vault.on("create", async (file) => {
				// Allow disabling this handler to prevent unwanted uploads from sync/external processes
				if (this.settings.disableAutoUploadOnCreate) return;
				if (!(file instanceof TFile)) return;
				if (!file.path.match(/\.(jpg|jpeg|png|gif|webp)$/i)) return;

				const activeView =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!activeView) return;

				// If the active note has localUpload: true, this "create" event was
				// fired by our own writeBinary() call — skip to avoid an infinite loop.
				const activeNote = this.app.workspace.getActiveFile();
				if (activeNote) {
					const noteFm = this.app.metadataCache.getFileCache(activeNote)?.frontmatter;
					if (noteFm?.localUpload === true) return;
				}

				// Check if uploads should be ignored for the current file
				if (this.shouldIgnoreCurrentFile(file.path)) {
					return; // Don't process the file, let Obsidian handle it normally
				}

				try {
					const fileContent = await this.app.vault.readBinary(file);
					const newFile = new File([fileContent], file.name, {
						type: `image/${file.extension}`,
					});

					// Do the upload
					await this.pasteHandler(null, activeView.editor, newFile);

					// Small delay to ensure editor content is updated
					await new Promise((resolve) => setTimeout(resolve, 50));

					// Now remove the original link if it exists
					const content = activeView.editor.getValue();
					// Check if the "Use [[Wikilinks]]" option is disabled
					const obsidianLink = (this.app.vault as any).getConfig(
						"useMarkdownLinks",
					)
						? `![](${file.name.split(" ").join("%20")})`
						: `![[${file.name}]]`; // Exact pattern we want to find
					const position = content.indexOf(obsidianLink);

					if (position !== -1) {
						const from = activeView.editor.offsetToPos(position);
						const to = activeView.editor.offsetToPos(
							position + obsidianLink.length,
						);
						activeView.editor.replaceRange("", from, to);
					} else {
						new Notice(`Failed to find: ${obsidianLink}`);
					}

					await this.app.vault.delete(file);
				} catch (error) {
					new Notice(`Error processing file: ${error.message}`);
				}
			}),
		);
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class S3UploaderSettingTab extends PluginSettingTab {
	plugin: S3UploaderPlugin;
	// Add properties to store compression setting elements
	private compressionSizeSettings: Setting;
	private compressionQualitySettings: Setting;
	private compressionDimensionSettings: Setting;

	constructor(app: App, plugin: S3UploaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Toggle visibility of compression settings
	 * @param show Whether to show the compression settings
	 */
	private toggleCompressionSettings(show: boolean): void {
		if (
			this.compressionSizeSettings &&
			this.compressionQualitySettings &&
			this.compressionDimensionSettings
		) {
			const displayStyle = show ? "" : "none";
			this.compressionSizeSettings.settingEl.style.display = displayStyle;
			this.compressionQualitySettings.settingEl.style.display =
				displayStyle;
			this.compressionDimensionSettings.settingEl.style.display =
				displayStyle;
		}
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h2", { text: "Settings for S3 Image Uploader" });

		containerEl.createEl("br");

		const coffeeDiv = containerEl.createDiv("coffee");
		const coffeeLink = coffeeDiv.createEl("a", {
			href: "https://www.buymeacoffee.com/jvsteiner",
		});
		const coffeeImg = coffeeLink.createEl("img", {
			attr: {
				src: "https://cdn.buymeacoffee.com/buttons/v2/default-blue.png",
			},
		});
		coffeeImg.height = 45;
		containerEl.createEl("br");

		new Setting(containerEl)
			.setName("AWS Access Key ID")
			.setDesc("AWS access key ID for a user with S3 access.")
			.addText((text) => {
				wrapTextWithPasswordHide(text);
				text.setPlaceholder("access key")
					.setValue(this.plugin.settings.accessKey)
					.onChange(async (value) => {
						this.plugin.settings.accessKey = value.trim();
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("AWS Secret Key")
			.setDesc("AWS secret key for that user.")
			.addText((text) => {
				wrapTextWithPasswordHide(text);
				text.setPlaceholder("secret key")
					.setValue(this.plugin.settings.secretKey)
					.onChange(async (value) => {
						this.plugin.settings.secretKey = value.trim();
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Region")
			.setDesc("AWS region of the S3 bucket.")
			.addText((text) =>
				text
					.setPlaceholder("aws region")
					.setValue(this.plugin.settings.region)
					.onChange(async (value) => {
						this.plugin.settings.region = value.trim();
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("S3 Bucket")
			.setDesc("S3 bucket name.")
			.addText((text) =>
				text
					.setPlaceholder("bucket name")
					.setValue(this.plugin.settings.bucket)
					.onChange(async (value) => {
						this.plugin.settings.bucket = value.trim();
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Bucket folder")
			.setDesc(
				"Optional folder in s3 bucket. Support the use of ${year}, ${month}, ${day} and ${basename} variables.",
			)
			.addText((text) =>
				text
					.setPlaceholder("folder")
					.setValue(this.plugin.settings.folder)
					.onChange(async (value) => {
						this.plugin.settings.folder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Upload on drag")
			.setDesc(
				"Upload drag and drop images as well as pasted images. To override this setting on a per-document basis, you can add `uploadOnDrag: true` to YAML frontmatter of the note.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uploadOnDrag)
					.onChange(async (value) => {
						this.plugin.settings.uploadOnDrag = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Upload video files")
			.setDesc(
				"Upload videos. To override this setting on a per-document basis, you can add `uploadVideo: true` to YAML frontmatter of the note.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uploadVideo)
					.onChange(async (value) => {
						this.plugin.settings.uploadVideo = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Upload audio files")
			.setDesc(
				"Upload audio files. To override this setting on a per-document basis, you can add `uploadAudio: true` to YAML frontmatter of the note.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uploadAudio)
					.onChange(async (value) => {
						this.plugin.settings.uploadAudio = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Upload pdf files")
			.setDesc(
				"Upload and embed PDF files. To override this setting on a per-document basis, you can add `uploadPdf: true` to YAML frontmatter of the note. Local uploads are not supported for PDF files.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uploadPdf)
					.onChange(async (value) => {
						this.plugin.settings.uploadPdf = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Ask to rename file before upload")
			.setDesc(
				"Shows a popup to rename the file before uploading. The name is auto-formatted to be URL-safe.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.askRename)
					.onChange(async (value) => {
						this.plugin.settings.askRename = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Use custom endpoint")
			.setDesc("Use the custom api endpoint below.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.useCustomEndpoint)
					.onChange(async (value) => {
						this.plugin.settings.useCustomEndpoint = value;
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Custom S3 Endpoint")
			.setDesc(
				"Optionally set a custom endpoint for any S3 compatible storage provider.",
			)
			.addText((text) =>
				text
					.setPlaceholder("https://s3.myhost.com/")
					.setValue(this.plugin.settings.customEndpoint)
					.onChange(async (value) => {
						value = value.match(/^https?:\/\//) // Force to start http(s)://
							? value
							: "https://" + value;
						value = value.replace(/([^/])$/, "$1/"); // Force to end with slash
						this.plugin.settings.customEndpoint = value.trim();
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("S3 Path Style URLs")
			.setDesc(
				"Advanced option to force using (legacy) path-style s3 URLs (s3.myhost.com/bucket) instead of the modern AWS standard host-style (bucket.s3.myhost.com).",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.forcePathStyle)
					.onChange(async (value) => {
						this.plugin.settings.forcePathStyle = value;
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Use custom image URL")
			.setDesc("Use the custom image URL below.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.useCustomImageUrl)
					.onChange(async (value) => {
						this.plugin.settings.useCustomImageUrl = value;
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Custom Image URL")
			.setDesc(
				"Advanced option to force inserting custom image URLs. This option is helpful if you are using CDN.",
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.customImageUrl)
					.onChange(async (value) => {
						value = value.match(/^https?:\/\//) // Force to start http(s)://
							? value
							: "https://" + value;
						value = value.replace(/([^/])$/, "$1/"); // Force to end with slash
						this.plugin.settings.customImageUrl = value.trim();
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Bypass local CORS check")
			.setDesc(
				"Bypass local CORS preflight checks - it might work on later versions of Obsidian.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.bypassCors)
					.onChange(async (value) => {
						this.plugin.settings.bypassCors = value;
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					});
			});
		new Setting(containerEl)
			.setName("Query String Key")
			.setDesc("Appended to the end of the URL. Optional")
			.addText((text) =>
				text
					.setPlaceholder("Empty means no query string key")
					.setValue(this.plugin.settings.queryStringKey)
					.onChange(async (value) => {
						this.plugin.settings.queryStringKey = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Query String Value")
			.setDesc("Appended to the end of the URL. Optional")
			.addText((text) =>
				text
					.setPlaceholder("Empty means no query string value")
					.setValue(this.plugin.settings.queryStringValue)
					.onChange(async (value) => {
						this.plugin.settings.queryStringValue = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Enable Image Compression")
			.setDesc("This will reduce the size of images before uploading.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.enableImageCompression)
					.onChange(async (value) => {
						this.plugin.settings.enableImageCompression = value;
						await this.plugin.saveSettings();

						// Show or hide compression settings based on toggle value
						this.toggleCompressionSettings(value);
					});
			});

		// Always create the compression settings, but control visibility
		this.compressionSizeSettings = new Setting(containerEl)
			.setName("Max Image Size")
			.setDesc(
				"Maximum size of the image after compression in MB. Default is 1MB.",
			)
			.addText((text) =>
				text
					.setPlaceholder("1")
					.setValue(
						this.plugin.settings.maxImageCompressionSize.toString(),
					)
					.onChange(async (value) => {
						// It must be a number, it must be greater than 0
						const newValue = parseFloat(value);
						if (isNaN(newValue) || newValue <= 0) {
							new Notice(
								"Max Image Compression Size must be a number greater than 0",
							);
							return;
						}

						this.plugin.settings.maxImageCompressionSize = newValue;
						await this.plugin.saveSettings();
					}),
			);

		this.compressionQualitySettings = new Setting(containerEl)
			.setName("Image Compression Quality")
			.setDesc(
				"Maximum quality of the image after compression. Default is 0.7.",
			)
			.addSlider((slider) => {
				slider.setDynamicTooltip();
				slider.setLimits(0.0, 1.0, 0.05);
				slider.setValue(this.plugin.settings.imageCompressionQuality);
				slider.onChange(async (value) => {
					this.plugin.settings.imageCompressionQuality = value;
					await this.plugin.saveSettings();
				});
			});

		this.compressionDimensionSettings = new Setting(containerEl)
			.setName("Max Image Width or Height")
			.setDesc(
				"Maximum width or height of the image after compression. Default is 4096px.",
			)
			.addText((text) =>
				text
					.setPlaceholder("4096")
					.setValue(
						this.plugin.settings.maxImageWidthOrHeight.toString(),
					)
					.onChange(async (value) => {
						const parsedValue = parseInt(value);

						if (isNaN(parsedValue) || parsedValue <= 0) {
							new Notice(
								"Max Image Width or Height must be a number greater than 0",
							);
							return;
						}

						this.plugin.settings.maxImageWidthOrHeight =
							parsedValue;
						await this.plugin.saveSettings();
					}),
			);

		// Set initial visibility based on current settings
		this.toggleCompressionSettings(
			this.plugin.settings.enableImageCompression,
		);

		new Setting(containerEl)
			.setName("Disable auto-upload on file create")
			.setDesc(
				"Disable automatic upload when image files are created in the vault (e.g., via sync or external processes). Paste and drag-drop uploads will still work. Enable this if you experience unwanted uploads on startup or when using cloud sync.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.disableAutoUploadOnCreate)
					.onChange(async (value) => {
						this.plugin.settings.disableAutoUploadOnCreate = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Ignore Pattern")
			.setDesc(
				"Glob pattern to ignore files/folders. Use * for any characters, ** for any path, ? for single character. Separate multiple patterns with commas. Example: 'private/*, **/drafts/**, temp*'",
			)
			.addText((text) =>
				text
					.setPlaceholder("private/*, **/drafts/**")
					.setValue(this.plugin.settings.ignorePattern)
					.onChange(async (value) => {
						this.plugin.settings.ignorePattern = value.trim();
						await this.plugin.saveSettings();
					}),
			);

	}
}


const wrapTextWithPasswordHide = (text: TextComponent) => {
	const hider = text.inputEl.insertAdjacentElement(
		"beforebegin",
		createSpan(),
	);
	if (!hider) {
		return;
	}
	setIcon(hider as HTMLElement, "eye-off");

	hider.addEventListener("click", () => {
		const isText = text.inputEl.getAttribute("type") === "text";
		if (isText) {
			setIcon(hider as HTMLElement, "eye-off");
			text.inputEl.setAttribute("type", "password");
		} else {
			setIcon(hider as HTMLElement, "eye");
			text.inputEl.setAttribute("type", "text");
		}
		text.inputEl.focus();
	});
	text.inputEl.setAttribute("type", "password");
	return text;
};

const wrapFileDependingOnType = (
	location: string,
	type: string,
	localBase: string,
) => {
	const srcPrefix = localBase ? "file://" + localBase + "/" : "";

	if (type === "image") {
		return `![image](${location})`;
	} else if (type === "video") {
		return `<video src="${srcPrefix}${location}" controls />`;
	} else if (type === "audio") {
		return `<audio src="${srcPrefix}${location}" controls />`;
	} else if (type === "pdf") {
		if (localBase) {
			throw new Error("PDFs cannot be embedded in local mode");
		}
		return `<iframe frameborder=0 border=0 width=100% height=800
		src="https://docs.google.com/viewer?embedded=true&url=${location}?raw=true">
		</iframe>`;
	} else if (type === "ppt") {
		return `<iframe
	    src='https://view.officeapps.live.com/op/embed.aspx?src=${location}'
	    width='100%' height='600px' frameborder='0'>
	  </iframe>`;
	} else {
		throw new Error("Unknown file type");
	}
};

////////////////////////////////////////////////////////////////////////////////
// special handler using Obsidian requestUrl
////////////////////////////////////////////////////////////////////////////////

/**
 * This is close to origin implementation of FetchHttpHandler
 * https://github.com/aws/aws-sdk-js-v3/blob/main/packages/fetch-http-handler/src/fetch-http-handler.ts
 * that is released under Apache 2 License.
 * But this uses Obsidian requestUrl instead.
 */
class ObsHttpHandler extends FetchHttpHandler {
	requestTimeoutInMs: number | undefined;
	constructor(options?: FetchHttpHandlerOptions) {
		super(options);
		this.requestTimeoutInMs =
			options === undefined ? undefined : options.requestTimeout;
	}
	async handle(
		request: HttpRequest,
		{ abortSignal }: HttpHandlerOptions = {},
	): Promise<{ response: HttpResponse }> {
		if (abortSignal?.aborted) {
			const abortError = new Error("Request aborted");
			abortError.name = "AbortError";
			return Promise.reject(abortError);
		}

		let path = request.path;
		if (request.query) {
			const queryString = buildQueryString(request.query);
			if (queryString) {
				path += `?${queryString}`;
			}
		}

		const { port, method } = request;
		const url = `${request.protocol}//${request.hostname}${
			port ? `:${port}` : ""
		}${path}`;
		const body =
			method === "GET" || method === "HEAD" ? undefined : request.body;

		const transformedHeaders: Record<string, string> = {};
		for (const key of Object.keys(request.headers)) {
			const keyLower = key.toLowerCase();
			if (keyLower === "host" || keyLower === "content-length") {
				continue;
			}
			transformedHeaders[keyLower] = request.headers[key];
		}

		let contentType: string | undefined = undefined;
		if (transformedHeaders["content-type"] !== undefined) {
			contentType = transformedHeaders["content-type"];
		}

		let transformedBody: string | ArrayBuffer | undefined;
		if (typeof body === "string") {
			transformedBody = body;
		} else if (body instanceof ArrayBuffer) {
			transformedBody = body;
		} else if (ArrayBuffer.isView(body)) {
			transformedBody = bufferToArrayBuffer(body);
		}

		const param: RequestUrlParam = {
			body: transformedBody,
			headers: transformedHeaders,
			method: method,
			url: url,
			contentType: contentType,
		};

		const raceOfPromises = [
			requestUrl(param).then((rsp) => {
				const headers = rsp.headers;
				const headersLower: Record<string, string> = {};
				for (const key of Object.keys(headers)) {
					headersLower[key.toLowerCase()] = headers[key];
				}
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(rsp.arrayBuffer));
						controller.close();
					},
				});
				return {
					response: new HttpResponse({
						headers: headersLower,
						statusCode: rsp.status,
						body: stream,
					}),
				};
			}),
			requestTimeout(this.requestTimeoutInMs),
		];

		if (abortSignal) {
			raceOfPromises.push(
				new Promise<never>((resolve, reject) => {
					abortSignal.onabort = () => {
						const abortError = new Error("Request aborted");
						abortError.name = "AbortError";
						reject(abortError);
					};
				}),
			);
		}
		return Promise.race(raceOfPromises);
	}
}

class RenameModal extends Modal {
	result: string;
	originalName: string;
	onSubmit: (result: string) => void;
	submitted = false;

	constructor(
		app: App,
		defaultName: string,
		onSubmit: (result: string) => void,
	) {
		super(app);
		this.result = defaultName;
		this.originalName = defaultName;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Name this file" });

		const inputSetting = new Setting(contentEl)
			.setName("Filename")
			.addText((text) =>
				text.setValue(this.result).onChange((value) => {
					this.result = value;
				}),
			);

		const inputEl = inputSetting.controlEl.querySelector(
			"input",
		) as HTMLInputElement;
		inputEl.focus();
		inputEl.select();

		inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.submitted = true;
				this.onSubmit(this.result);
				this.close();
			}
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Keep").onClick(() => {
					this.submitted = true;
					this.onSubmit(this.originalName);
					this.close();
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("Upload")
					.setCta()
					.onClick(() => {
						this.submitted = true;
						this.onSubmit(this.result);
						this.close();
					}),
			);
	}

	onClose() {
		if (!this.submitted) {
			this.onSubmit(this.originalName);
		}
	}
}

class ConflictModal extends Modal {
	onChoice: (choice: "rename" | "overwrite" | "cancel") => void;
	fileName: string;
	submitted = false;

	constructor(
		app: App,
		fileName: string,
		onChoice: (choice: "rename" | "overwrite" | "cancel") => void,
	) {
		super(app);
		this.fileName = fileName;
		this.onChoice = onChoice;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "File already exists" });
		contentEl.createEl("p", {
			text: `A file named "${this.fileName}" already exists in the target folder.`,
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Rename").onClick(() => {
					this.submitted = true;
					this.onChoice("rename");
					this.close();
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("Overwrite")
					.setWarning()
					.onClick(() => {
						this.submitted = true;
						this.onChoice("overwrite");
						this.close();
					}),
			)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => {
					this.submitted = true;
					this.onChoice("cancel");
					this.close();
				}),
			);
	}

	onClose() {
		if (!this.submitted) {
			this.onChoice("cancel");
		}
	}
}

function bufferToArrayBuffer(b: Uint8Array | ArrayBufferView): ArrayBuffer {
	const view = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
	return view.slice().buffer;
}

async function generateFileHash(data: ArrayBuffer): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return hashHex.slice(0, 32); // Truncate to same length as MD5 for compatibility
}

/**
 * Check if a file path matches a glob pattern using minimatch
 * Supports standard glob patterns: *, **, ?, etc.
 */
function matchesGlobPattern(filePath: string, pattern: string): boolean {
	if (!pattern || pattern.trim() === "") {
		return false;
	}

	// Split patterns by comma to support multiple patterns
	const patterns = pattern.split(",").map((p) => p.trim());

	return patterns.some((p) => {
		return minimatch(filePath, p);
	});
}
