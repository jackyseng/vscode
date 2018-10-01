/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as pfs from 'vs/base/node/pfs';
import { memoize } from 'vs/base/common/decorators';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ILifecycleService } from 'vs/platform/lifecycle/electron-main/lifecycleMain';
import { IRequestService } from 'vs/platform/request/node/request';
import product from 'vs/platform/node/product';
import { TPromise, Promise } from 'vs/base/common/winjs.base';
import { State, IUpdate, StateType, AvailableForDownload, UpdateType } from 'vs/platform/update/common/update';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { ILogService } from 'vs/platform/log/common/log';
import { createUpdateURL, AbstractUpdateService } from 'vs/platform/update/electron-main/abstractUpdateService';
import { download, asJson } from 'vs/base/node/request';
import { checksum } from 'vs/base/node/crypto';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { shell } from 'electron';
import { CancellationToken } from 'vs/base/common/cancellation';

function pollUntil(fn: () => boolean, timeout = 1000): TPromise<void> {
	return new TPromise<void>(c => {
		const poll = () => {
			if (fn()) {
				c(null);
			} else {
				setTimeout(poll, timeout);
			}
		};

		poll();
	});
}

interface IAvailableUpdate {
	packagePath: string;
	updateFilePath?: string;
}

let _updateType: UpdateType | undefined = undefined;
function getUpdateType(): UpdateType {
	if (typeof _updateType === 'undefined') {
		_updateType = fs.existsSync(path.join(path.dirname(process.execPath), 'unins000.exe'))
			? UpdateType.Setup
			: UpdateType.Archive;
	}

	return _updateType;
}

export class Win32UpdateService extends AbstractUpdateService {

	_serviceBrand: any;

	private availableUpdate: IAvailableUpdate | undefined;

	@memoize
	get cachePath(): TPromise<string> {
		const result = path.join(tmpdir(), `vscode-update-${product.target}-${process.arch}`);
		return pfs.mkdirp(result, null).then(() => result);
	}

	constructor(
		@ILifecycleService lifecycleService: ILifecycleService,
		@IConfigurationService configurationService: IConfigurationService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IRequestService requestService: IRequestService,
		@ILogService logService: ILogService
	) {
		super(lifecycleService, configurationService, environmentService, requestService, logService);

		if (getUpdateType() === UpdateType.Setup) {
			/* __GDPR__
				"update:win32SetupTarget" : {
					"target" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
				}
			*/
			/* __GDPR__
				"update:win<NUMBER>SetupTarget" : {
					"target" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
				}
			*/
			telemetryService.publicLog('update:win32SetupTarget', { target: product.target });
		}
	}

	protected buildUpdateFeedUrl(quality: string): string | undefined {
		let platform = 'win32';

		if (process.arch === 'x64') {
			platform += '-x64';
		}

		if (getUpdateType() === UpdateType.Archive) {
			platform += '-archive';
		} else if (product.target === 'user') {
			platform += '-user';
		}

		return createUpdateURL(platform, quality);
	}

	protected doCheckForUpdates(context: any): void {
		if (!this.url) {
			return;
		}

		this.setState(State.CheckingForUpdates(context));

		this.requestService.request({ url: this.url }, CancellationToken.None)
			.then<IUpdate>(asJson)
			.then(update => {
				const updateType = getUpdateType();

				if (!update || !update.url || !update.version || !update.productVersion) {
					/* __GDPR__
							"update:notAvailable" : {
								"explicit" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true }
							}
						*/
					this.telemetryService.publicLog('update:notAvailable', { explicit: !!context });

					this.setState(State.Idle(updateType));
					return TPromise.as(null);
				}

				if (updateType === UpdateType.Archive) {
					this.setState(State.AvailableForDownload(update));
					return TPromise.as(null);
				}

				this.setState(State.Downloading(update));

				return this.cleanup(update.version).then(() => {
					return this.getUpdatePackagePath(update.version).then(updatePackagePath => {
						return pfs.exists(updatePackagePath).then(exists => {
							if (exists) {
								return TPromise.as(updatePackagePath);
							}

							const url = update.url;
							const hash = update.hash;
							const downloadPath = `${updatePackagePath}.tmp`;

							return this.requestService.request({ url }, CancellationToken.None)
								.then(context => download(downloadPath, context))
								.then(hash ? () => checksum(downloadPath, update.hash) : () => null)
								.then(() => pfs.rename(downloadPath, updatePackagePath))
								.then(() => updatePackagePath);
						});
					}).then(packagePath => {
						const fastUpdatesEnabled = this.configurationService.getValue<boolean>('update.enableWindowsBackgroundUpdates');

						this.availableUpdate = { packagePath };

						if (fastUpdatesEnabled && update.supportsFastUpdate) {
							if (product.target === 'user') {
								this.doApplyUpdate();
							} else {
								this.setState(State.Downloaded(update));
							}
						} else {
							this.setState(State.Ready(update));
						}
					});
				});
			})
			.then(null, err => {
				this.logService.error(err);
				/* __GDPR__
					"update:notAvailable" : {
						"explicit" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true }
					}
					*/
				this.telemetryService.publicLog('update:notAvailable', { explicit: !!context });
				this.setState(State.Idle(getUpdateType(), err.message || err));
			});
	}

	protected doDownloadUpdate(state: AvailableForDownload): TPromise<void> {
		shell.openExternal(state.update.url);
		this.setState(State.Idle(getUpdateType()));
		return TPromise.as(null);
	}

	private getUpdatePackagePath(version: string): TPromise<string> {
		return this.cachePath.then(cachePath => path.join(cachePath, `CodeSetup-${product.quality}-${version}.exe`));
	}

	private cleanup(exceptVersion: string = null): Promise {
		const filter = exceptVersion ? one => !(new RegExp(`${product.quality}-${exceptVersion}\\.exe$`).test(one)) : () => true;

		return this.cachePath
			.then(cachePath => pfs.readdir(cachePath)
				.then(all => Promise.join(all
					.filter(filter)
					.map(one => pfs.unlink(path.join(cachePath, one)).then(null, () => null))
				))
			);
	}

	protected doApplyUpdate(): TPromise<void> {
		if (this.state.type !== StateType.Downloaded && this.state.type !== StateType.Downloading) {
			return TPromise.as(null);
		}

		if (!this.availableUpdate) {
			return TPromise.as(null);
		}

		const update = this.state.update;
		this.setState(State.Updating(update));

		return this.cachePath.then(cachePath => {
			this.availableUpdate.updateFilePath = path.join(cachePath, `CodeSetup-${product.quality}-${update.version}.flag`);

			return pfs.writeFile(this.availableUpdate.updateFilePath, 'flag').then(() => {
				const child = spawn(this.availableUpdate.packagePath, ['/verysilent', `/update="${this.availableUpdate.updateFilePath}"`, '/nocloseapplications', '/mergetasks=runcode,!desktopicon,!quicklaunchicon'], {
					detached: true,
					stdio: ['ignore', 'ignore', 'ignore'],
					windowsVerbatimArguments: true
				});

				child.once('exit', () => {
					this.availableUpdate = undefined;
					this.setState(State.Idle(getUpdateType()));
				});

				const readyMutexName = `${product.win32MutexName}-ready`;
				const isActive = (require.__$__nodeRequire('windows-mutex') as any).isActive;

				// poll for mutex-ready
				pollUntil(() => isActive(readyMutexName))
					.then(() => this.setState(State.Ready(update)));
			});
		});
	}

	protected doQuitAndInstall(): void {
		if (this.state.type !== StateType.Ready) {
			return;
		}

		this.logService.trace('update#quitAndInstall(): running raw#quitAndInstall()');

		if (this.state.update.supportsFastUpdate && this.availableUpdate.updateFilePath) {
			fs.unlinkSync(this.availableUpdate.updateFilePath);
		} else {
			spawn(this.availableUpdate.packagePath, ['/silent', '/mergetasks=runcode,!desktopicon,!quicklaunchicon'], {
				detached: true,
				stdio: ['ignore', 'ignore', 'ignore']
			});
		}
	}

	protected getUpdateType(): UpdateType {
		return getUpdateType();
	}
}
