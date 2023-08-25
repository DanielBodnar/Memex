import type { Tabs, Runtime, Extension } from 'webextension-polyfill'
import type { UIEventHandler } from '@worldbrain/memex-common/lib/main-ui/classes/logic'
import {
    UILogic,
    loadInitial,
} from '@worldbrain/memex-common/lib/main-ui/classes/logic'
import type { UITaskState } from '@worldbrain/memex-common/lib/main-ui/types'
import type { SyncSettingsStore } from 'src/sync-settings/util'
import type { PDFRemoteInterface } from 'src/pdf/background/types'
import type { RemoteCollectionsInterface } from 'src/custom-lists/background/types'
import { constructPDFViewerUrl, isUrlPDFViewerUrl } from 'src/pdf/util'
import type { PageIndexingInterface } from 'src/page-indexing/background/types'
import { getCurrentTab } from './utils'
import { AnalyticsInterface } from 'src/analytics/background/types'

export interface Dependencies {
    extensionAPI: Pick<Extension.Static, 'isAllowedFileSchemeAccess'>
    tabsAPI: Pick<Tabs.Static, 'create' | 'query' | 'update'>
    runtimeAPI: Pick<Runtime.Static, 'getURL'>
    syncSettings: SyncSettingsStore<'pdfIntegration' | 'extension'>
    customListsBG: RemoteCollectionsInterface
    pdfIntegrationBG: PDFRemoteInterface
    pageIndexingBG: PageIndexingInterface<'caller'>
    analyticsBG: AnalyticsInterface
}

export interface Event {
    togglePDFReader: null
    togglePDFReaderEnabled: null
    addPageList: { listId: number }
    delPageList: { listId: number }
}

export interface State {
    pageListIds: number[]
    loadState: UITaskState
    currentTabFullUrl: string
    identifierFullUrl: string
    /** In the case of a PDF, contains the URL to the web-available PDF. Else is just the full tab URL. */
    underlyingResourceUrl: string
    shouldShowTagsUIs: boolean
    isPDFReaderEnabled: boolean
    isFileAccessAllowed: boolean
    showAutoSaved: boolean
    analyticsBG: AnalyticsInterface
}

type EventHandler<EventName extends keyof Event> = UIEventHandler<
    State,
    Event,
    EventName
>

export default class PopupLogic extends UILogic<State, Event> {
    constructor(private dependencies: Dependencies) {
        super()
    }

    getInitialState = (): State => ({
        pageListIds: [],
        currentTabFullUrl: '',
        identifierFullUrl: '',
        underlyingResourceUrl: '',
        loadState: 'pristine',
        shouldShowTagsUIs: false,
        isPDFReaderEnabled: false,
        isFileAccessAllowed: false,
        showAutoSaved: false,
        analyticsBG: null,
    })

    async init() {
        const {
            tabsAPI,
            syncSettings,
            runtimeAPI,
            extensionAPI,
            customListsBG,
            analyticsBG,
            pageIndexingBG,
        } = this.dependencies

        await loadInitial(this, async () => {
            const [areTagsMigrated, isPDFReaderEnabled] = await Promise.all([
                syncSettings.extension.get('areTagsMigratedToSpaces'),
                syncSettings.pdfIntegration.get('shouldAutoOpen'),
            ])

            const currentTab = await getCurrentTab({ runtimeAPI, tabsAPI })
            const identifier = await pageIndexingBG.waitForContentIdentifier({
                tabId: currentTab.id,
                fullUrl: currentTab.url,
            })

            const pageListIds = await customListsBG.fetchPageLists({
                url: identifier.fullUrl,
            })

            const isFileAccessAllowed = await extensionAPI.isAllowedFileSchemeAccess()
            this.emitMutation({
                analyticsBG: { $set: analyticsBG },
                pageListIds: { $set: pageListIds },
                currentTabFullUrl: { $set: currentTab.originalUrl },
                identifierFullUrl: { $set: identifier.fullUrl },
                underlyingResourceUrl: { $set: currentTab.url },
                shouldShowTagsUIs: { $set: !areTagsMigrated },
                isPDFReaderEnabled: { $set: isPDFReaderEnabled },
                isFileAccessAllowed: { $set: isFileAccessAllowed },
            })
        })
    }

    togglePDFReader: EventHandler<'togglePDFReader'> = async ({
        previousState: { currentTabFullUrl },
    }) => {
        const { runtimeAPI, tabsAPI, pdfIntegrationBG } = this.dependencies
        const [currentTab] = await tabsAPI.query({
            active: true,
            currentWindow: true,
        })

        let nextPageUrl: string
        if (isUrlPDFViewerUrl(currentTabFullUrl, { runtimeAPI })) {
            nextPageUrl = decodeURIComponent(
                currentTabFullUrl.split('?file=')[1].toString(),
            )
            await pdfIntegrationBG.doNotOpenPdfViewerForNextPdf()
        } else {
            nextPageUrl = constructPDFViewerUrl(currentTabFullUrl, {
                runtimeAPI,
            })
            await pdfIntegrationBG.openPdfViewerForNextPdf()
        }

        await tabsAPI.update(currentTab.id, { url: nextPageUrl })
        this.emitMutation({ currentTabFullUrl: { $set: nextPageUrl } })
    }

    addPageList: EventHandler<'addPageList'> = async ({
        event,
        previousState,
    }) => {
        const pageListIdsSet = new Set(previousState.pageListIds)
        pageListIdsSet.add(event.listId)
        this.emitMutation({
            pageListIds: { $set: [...pageListIdsSet] },
            showAutoSaved: { $set: true },
        })
    }

    delPageList: EventHandler<'delPageList'> = async ({
        event,
        previousState,
    }) => {
        const pageListIdsSet = new Set(previousState.pageListIds)
        pageListIdsSet.delete(event.listId)
        this.emitMutation({
            pageListIds: { $set: [...pageListIdsSet] },
            showAutoSaved: { $set: true },
        })
    }

    togglePDFReaderEnabled: EventHandler<'togglePDFReaderEnabled'> = async ({
        previousState,
    }) => {
        const { syncSettings, pdfIntegrationBG } = this.dependencies
        this.emitMutation({
            isPDFReaderEnabled: { $set: !previousState.isPDFReaderEnabled },
        })
        await syncSettings.pdfIntegration.set(
            'shouldAutoOpen',
            !previousState.isPDFReaderEnabled,
        )
        await pdfIntegrationBG.refreshSetting()
    }
}
