import fromPairs from 'lodash/fromPairs'
import clone from 'lodash/cloneDeep'
import browser from 'webextension-polyfill'
import {
    UILogic,
    UIEventHandler,
    UIMutation,
    loadInitial,
    executeUITask,
} from '@worldbrain/memex-common/lib/main-ui/classes/logic'
import {
    normalizeUrl,
    isFullUrl,
} from '@worldbrain/memex-common/lib/url-utils/normalize'
import {
    annotationConversationInitialState,
    annotationConversationEventHandlers,
    detectAnnotationConversationThreads,
} from '@worldbrain/memex-common/lib/content-conversations/ui/logic'
import type { ConversationIdBuilder } from '@worldbrain/memex-common/lib/content-conversations/ui/types'
import type { Annotation } from 'src/annotations/types'
import type {
    SidebarContainerDependencies,
    SidebarContainerState,
    SidebarContainerEvents,
    EditForm,
    AnnotationCardInstanceEvent,
    SuggestionCard,
} from './types'
import type { AnnotationsSidebarInPageEventEmitter } from '../types'
import { DEF_RESULT_LIMIT } from '../constants'
import {
    generateAnnotationUrl,
    shareOptsToPrivacyLvl,
} from 'src/annotations/utils'
import { FocusableComponent } from 'src/annotations/components/types'
import {
    NormalizedState,
    initNormalizedState,
    normalizedStateToArray,
} from '@worldbrain/memex-common/lib/common-ui/utils/normalized-state'
import {
    SyncSettingsStore,
    createSyncSettingsStore,
} from 'src/sync-settings/util'
import { SIDEBAR_WIDTH_STORAGE_KEY } from '../constants'
import { AI_PROMPT_DEFAULTS } from '../constants'
import {
    getInitialAnnotationConversationState,
    getInitialAnnotationConversationStates,
} from '@worldbrain/memex-common/lib/content-conversations/ui/utils'
import { AnnotationPrivacyLevels } from '@worldbrain/memex-common/lib/annotations/types'
import type {
    PageAnnotationsCacheEvents,
    RGBAColor,
    UnifiedAnnotation,
    UnifiedList,
    UnifiedListForCache,
} from 'src/annotations/cache/types'
import * as cacheUtils from 'src/annotations/cache/utils'
import {
    createAnnotation,
    updateAnnotation,
} from 'src/annotations/annotation-save-logic'
import {
    generateAnnotationCardInstanceId,
    initAnnotationCardInstance,
    initListInstance,
} from './utils'
import type { AnnotationSharingState } from 'src/content-sharing/background/types'
import type { YoutubePlayer } from '@worldbrain/memex-common/lib/services/youtube/types'
import type { YoutubeService } from '@worldbrain/memex-common/lib/services/youtube'
import type { SharedAnnotationReference } from '@worldbrain/memex-common/lib/content-sharing/types'
import { isUrlPDFViewerUrl } from 'src/pdf/util'
import type { Storage } from 'webextension-polyfill'
import throttle from 'lodash/throttle'
import {
    getRemoteEventEmitter,
    TypedRemoteEventEmitter,
} from 'src/util/webextensionRPC'
import {
    AIActionAllowed,
    downloadMemexDesktop,
    rabbitHoleBetaFeatureAllowed,
    updateAICounter,
} from 'src/util/subscriptions/storage'
import {
    getListShareUrl,
    getSinglePageShareUrl,
} from 'src/content-sharing/utils'
import type { AutoPk } from '@worldbrain/memex-common/lib/storage/types'
import {
    convertMemexURLintoTelegramURL,
    getTelegramUserDisplayName,
} from '@worldbrain/memex-common/lib/telegram/utils'
import { enforceTrialPeriod30Days } from 'src/util/subscriptions/storage'
import {
    SpacePickerDependencies,
    SpacePickerEvent,
} from 'src/custom-lists/ui/CollectionPicker/types'
import { validateSpaceName } from '@worldbrain/memex-common/lib/utils/space-name-validation'
import { sleepPromise } from 'src/util/promises'
import { ImageSupportInterface } from 'src/image-support/background/types'
import sanitizeHTMLhelper from '@worldbrain/memex-common/lib/utils/sanitize-html-helper'
import { processCommentForImageUpload } from '@worldbrain/memex-common/lib/annotations/processCommentForImageUpload'
import { RemoteBGScriptInterface } from 'src/background-script/types'
import { marked } from 'marked'
import { constructVideoURLwithTimeStamp } from '@worldbrain/memex-common/lib/editor/utils'
import { HIGHLIGHT_COLORS_DEFAULT } from '@worldbrain/memex-common/lib/common-ui/components/highlightColorPicker/constants'
import { RGBAobjectToString } from '@worldbrain/memex-common/lib/common-ui/components/highlightColorPicker/utils'
import { PDFDocumentProxy } from 'pdfjs-dist/types/display/api'
import { extractDataFromPDFDocument } from '@worldbrain/memex-common/lib/page-indexing/content-extraction/extract-pdf-content'
import { MemexLocalBackend } from 'src/pkm-integrations/background/backend'
import { PKMSyncBackgroundModule } from 'src/pkm-integrations/background'
import { PkmSyncInterface } from 'src/pkm-integrations/background/types'

export type SidebarContainerOptions = SidebarContainerDependencies & {
    events?: AnnotationsSidebarInPageEventEmitter
}

export type SidebarLogicOptions = SidebarContainerOptions & {
    focusCreateForm: FocusableComponent['focus']
    focusEditNoteForm: (annotationId: string) => void
    setLoginModalShown?: (isShown: boolean) => void
    setDisplayNameModalShown?: (isShown: boolean) => void
    youtubePlayer?: YoutubePlayer
    youtubeService?: YoutubeService
    imageSupport?: ImageSupportInterface<'caller'>
    bgScriptBG?: RemoteBGScriptInterface
    spacesBG?: SpacePickerDependencies['spacesBG']
    pkmSyncBG?: PkmSyncInterface
}

type EventHandler<
    EventName extends keyof SidebarContainerEvents
> = UIEventHandler<SidebarContainerState, SidebarContainerEvents, EventName>

export const INIT_FORM_STATE: EditForm = {
    isBookmarked: false,
    commentText: '',
    lists: [],
}

export const createEditFormsForAnnotations = (annots: Annotation[]) => {
    const state: { [annotationUrl: string]: EditForm } = {}
    for (const annot of annots) {
        state[annot.url] = { ...INIT_FORM_STATE }
    }
    return state
}

const getAnnotCardInstanceId = <T = any>(
    e: AnnotationCardInstanceEvent<T>,
): string =>
    generateAnnotationCardInstanceId(
        { unifiedId: e.unifiedAnnotationId },
        e.instanceLocation,
    )

export class SidebarContainerLogic extends UILogic<
    SidebarContainerState,
    SidebarContainerEvents
> {
    syncSettings: SyncSettingsStore<
        'contentSharing' | 'extension' | 'openAI' | 'highlightColors'
    >
    resizeObserver
    sidebar
    readingViewState
    openAIkey
    showState
    focusIndex
    previousState
    summarisePageEvents: TypedRemoteEventEmitter<'pageSummary'>
    AIpromptSuggestions: { prompt: string; focused: boolean | null }[]
    // NOTE: this mirrors the state key of the same name. Only really exists as the cache's `updatedPageData` event listener can't access state :/
    private fullPageUrl: string
    private youtubeTranscriptSummary: string = ''
    private chapterSummaries

    constructor(private options: SidebarLogicOptions) {
        super()

        this.syncSettings = createSyncSettingsStore({
            syncSettingsBG: options.syncSettingsBG,
        })

        Object.assign(
            this,
            annotationConversationEventHandlers<SidebarContainerState>(
                this as any,
                {
                    buildConversationId: this.buildConversationId,
                    loadUserByReference: options.authBG?.getUserByReference,
                    submitNewReply: options.contentConversationsBG.submitReply,
                    deleteReply: options.contentConversationsBG.deleteReply,
                    editReply: options.contentConversationsBG.editReply,
                    isAuthorizedToConverse: async () => true,
                    getCurrentUser: async () => {
                        const user = await options.authBG.getCurrentUser()
                        if (!user) {
                            return null
                        }

                        return {
                            displayName: user.displayName,
                            reference: { type: 'user-reference', id: user.id },
                        }
                    },
                    selectAnnotationData: (state, reference) => {
                        const annotation = options.annotationsCache.getAnnotationByRemoteId(
                            reference.id.toString(),
                        )
                        if (!annotation) {
                            return null
                        }
                        return {
                            pageCreatorReference: annotation.creator,
                            normalizedPageUrl: normalizeUrl(
                                state.fullPageUrl ?? this.fullPageUrl,
                            ),
                        }
                    },
                    getSharedAnnotationLinkID: ({ id }) =>
                        typeof id === 'string' ? id : id.toString(),
                    getRepliesByAnnotation: async ({
                        annotationReference,
                        sharedListReference,
                    }) =>
                        options.contentConversationsBG.getRepliesBySharedAnnotation(
                            {
                                sharedAnnotationReference: annotationReference,
                                sharedListReference,
                            },
                        ),
                    imageSupport: options.imageSupport,
                },
            ),
        )
    }

    private get resultLimit(): number {
        return this.options.searchResultLimit ?? DEF_RESULT_LIMIT
    }

    getInitialState(): SidebarContainerState {
        let sidebarWidth = SIDEBAR_WIDTH_STORAGE_KEY
        if (window.location.href.includes('youtube.com/watch')) {
            const sidebarContainerWidth = document.getElementById('secondary')
                .clientWidth
            sidebarWidth = sidebarContainerWidth - 50 + 'px'
        }

        return {
            ...annotationConversationInitialState(),

            activeTab: 'annotations',

            cacheLoadState: this.options.shouldHydrateCacheOnInit
                ? 'pristine'
                : 'success',
            loadState: 'running',
            noteCreateState: 'pristine',
            pageLinkCreateState: 'pristine',
            secondarySearchState: 'pristine',
            remoteAnnotationsLoadState: 'pristine',
            foreignSelectedListLoadState: 'pristine',
            selectedTextAIPreview: undefined,
            sidebarWidth: sidebarWidth,
            activeSuggestionsTab: 'MySuggestions',
            activeAITab: 'ThisPage',

            users: {},
            currentUserReference: null,
            pillVisibility: 'unhover',
            videoDetails: null,
            summaryModeActiveTab: 'Answer',

            isWidthLocked: false,
            isLocked: false,
            fullPageUrl: this.options.fullPageUrl,
            showState: 'hidden',
            annotationSharingAccess: 'sharing-allowed',
            readingView: false,
            showAllNotesCopyPaster: false,
            pageSummary: '',
            selectedListId: null,
            spaceTitleEditValue: '',
            activeListContextMenuId: null,
            activeListEditMenuId: null,
            fetchLocalHTML: false,
            rabbitHoleBetaFeatureAccess: null,

            commentBox: { ...INIT_FORM_STATE },

            listInstances: {},
            annotationCardInstances: {},

            shareMenuAnnotationInstanceId: null,
            spacePickerAnnotationInstance: null,
            copyPasterAnnotationInstanceId: null,

            annotations: initNormalizedState(),
            lists: initNormalizedState(),
            pageListIds: new Set(),
            pageActiveListIds: [],

            activeAnnotationId: null, // TODO: make unified ID

            showCommentBox: false,
            showCongratsMessage: false,
            showClearFiltersBtn: false,
            showFiltersSidebar: false,
            showSocialSearch: false,
            shouldShowTagsUIs: false,
            prompt: undefined,
            showUpgradeModal: false,

            pageCount: 0,
            noResults: false,
            annotCount: 0,
            shouldShowCount: false,
            isInvalidSearch: false,
            totalResultCount: 0,
            isListFilterActive: false,
            searchResultSkip: 0,

            confirmPrivatizeNoteArgs: null,
            confirmSelectNoteSpaceArgs: null,

            showLoginModal: false,
            showDisplayNameSetupModal: false,
            showAnnotationsShareModal: false,
            popoutsActive: false,
            showAllNotesShareMenu: false,
            activeShareMenuNoteId: undefined,
            immediatelyShareNotes: false,
            pageHasNetworkAnnotations: false,
            queryMode: 'summarize',
            showLengthError: false,
            showAISuggestionsDropDown: false,
            showAICounter: false,
            AIsuggestions: [],
            isTrial: false,
            signupDate: null,
            firstTimeSharingPageLink: false,
            selectedShareMenuPageLinkList: null,
            renameListErrorMessage: null,
            sidebarRightBorderPosition: null,
            youtubeTranscriptSummaryloadState: 'pristine',
            pageListDataForCurrentPage: null,
            youtubeTranscriptJSON: null,
            showChapters: false,
            chapterSummaries: [],
            chapterList: [],
            AImodel: 'gpt-3.5-turbo-1106',
            hasKey: false,
            highlightColors: null,
            suggestionsResults: [],
            suggestionsResultsLoadState: 'pristine',
            desktopAppDownloadLink: null,
            showFeedSourcesMenu: false,
            existingSourcesOption: 'pristine',
            localFoldersList: [],
        }
    }

    buildConversationId: ConversationIdBuilder = (
        remoteAnnotId,
        { id: remoteListId },
    ) => {
        const { annotationsCache } = this.options
        const cachedAnnotation = annotationsCache.getAnnotationByRemoteId(
            remoteAnnotId.toString(),
        )
        const cachedList = annotationsCache.getListByRemoteId(
            remoteListId.toString(),
        )

        return generateAnnotationCardInstanceId(
            cachedAnnotation,
            cachedList.unifiedId,
        )
    }

    private async hydrateAnnotationsCache(
        fullPageUrl: string,
        opts: { renderHighlights: boolean },
    ) {
        await executeUITask(this, 'cacheLoadState', async () => {
            await cacheUtils.hydrateCacheForPageAnnotations({
                fullPageUrl,
                user: this.options.getCurrentUser(),
                cache: this.options.annotationsCache,
                skipListHydration: this.options.sidebarContext === 'dashboard',
                bgModules: {
                    customLists: this.options.customListsBG,
                    annotations: this.options.annotationsBG,
                    contentSharing: this.options.contentSharingBG,
                    pageActivityIndicator: this.options.pageActivityIndicatorBG,
                },
            })
        })

        if (opts.renderHighlights) {
            const annotations = this.transformAnnotations(
                this.options.annotationsCache.annotations,
            )
            const activeTab = 'annotations' // replace this with the actual value if available
            this.renderOwnHighlights({ annotations, activeTab })
        }
    }

    private transformAnnotations(
        annotations: any,
    ): NormalizedState<UnifiedAnnotation, string> {
        // Transform `annotations` into the format expected by `renderOwnHighlights`
        // This is just a placeholder. Replace with your actual transformation logic.
        return {
            allIds: [],
            byId: {},
        }
    }

    private renderOwnHighlights = (
        state: Pick<SidebarContainerState, 'annotations' | 'activeTab'>,
    ) => {
        const highlights = cacheUtils.getUserHighlightsArray(
            { annotations: state.annotations },
            this.options.getCurrentUser()?.id.toString(),
        )
        this.options.events?.emit('renderHighlights', {
            highlights,
            removeExisting: true,
        })
    }

    private renderOpenSpaceInstanceHighlights = ({
        annotations,
        listInstances,
        lists,
    }: Pick<
        SidebarContainerState,
        'annotations' | 'lists' | 'listInstances'
    >) => {
        this.options.events?.emit('renderHighlights', {
            highlights: [],
            removeExisting: true,
        })

        const highlights = Object.values(listInstances)
            .filter((instance) => instance.isOpen)
            .map(
                (instance) =>
                    lists.byId[instance.unifiedListId]?.unifiedAnnotationIds ??
                    [],
            )
            .flat()
            .map((unifiedAnnotId) => annotations.byId[unifiedAnnotId])
            .filter(
                (annot) => annot?.body?.length > 0 && annot.selector != null,
            )

        this.options.events?.emit('renderHighlights', {
            highlights,
            removeExisting: false,
        })
    }

    private setupRemoteEventListeners() {
        this.summarisePageEvents = getRemoteEventEmitter('pageSummary')

        let isPageSummaryEmpty = true
        this.summarisePageEvents.on('newSummaryToken', ({ token }) => {
            let newToken = token
            if (isPageSummaryEmpty) {
                newToken = newToken.trimStart() // Remove the first two characters
            }
            isPageSummaryEmpty = false
            this.emitMutation({
                loadState: { $set: 'success' },
                pageSummary: { $apply: (prev) => prev + newToken },
            })
        })
        this.summarisePageEvents.on('startSummaryStream', () => {
            this.emitMutation({
                pageSummary: { $set: '' },
            })
        })

        this.summarisePageEvents.on('newSummaryTokenEditor', ({ token }) => {
            let newToken = token

            if (isPageSummaryEmpty) {
                newToken = newToken.trimStart() // Remove the first two characters
            }
            isPageSummaryEmpty = false
            this.youtubeTranscriptSummary =
                this.youtubeTranscriptSummary + newToken
            this.emitMutation({
                youtubeTranscriptSummaryloadState: { $set: 'success' },
                youtubeTranscriptSummary: { $apply: (prev) => prev + newToken },
            })
            let handledSuccessfully = false

            this.options.events.emit(
                'triggerYoutubeTimestampSummary',
                {
                    text: newToken,
                },
                (success) => {
                    handledSuccessfully = success
                },
            )
        })
        this.summarisePageEvents.on(
            'newChapterSummaryToken',
            ({ token, chapterSummaryIndex }) => {
                let newToken = token
                if (this.chapterSummaries[chapterSummaryIndex] == null) {
                    newToken = newToken.trimStart() // Remove the first two characters
                }

                this.emitMutation({
                    chapterSummaries: {
                        [chapterSummaryIndex]: {
                            chapterIndex: { $set: chapterSummaryIndex },
                            summary: {
                                $apply: (prev) => (prev || '') + newToken,
                            },
                            loadingState: { $set: 'success' },
                        },
                    },
                })
            },
        )
    }

    getHighlightColorSettings: EventHandler<
        'getHighlightColorSettings'
    > = async ({ event, previousState }) => {
        let highlightColorJSON
        if (previousState.highlightColors) {
            highlightColorJSON = JSON.parse(previousState.highlightColors)
        } else {
            const highlightColors = await this.syncSettings.highlightColors.get(
                'highlightColors',
            )

            if (highlightColors) {
                highlightColorJSON = highlightColors
            } else {
                highlightColorJSON = HIGHLIGHT_COLORS_DEFAULT
                await this.syncSettings.highlightColors.set(
                    'highlightColors',
                    highlightColorJSON,
                )
            }
        }

        this.emitMutation({
            highlightColors: { $set: JSON.stringify(highlightColorJSON) },
        })

        return highlightColorJSON
    }
    saveHighlightColor: EventHandler<'saveHighlightColor'> = async ({
        event,
        previousState,
    }) => {
        const {
            annotations: {
                byId: { [event.noteId]: annotationData },
            },
        } = previousState

        if (annotationData?.creator?.id !== this.options.getCurrentUser()?.id) {
            return
        }

        await updateAnnotation({
            annotationsBG: this.options.annotationsBG,
            contentSharingBG: this.options.contentSharingBG,
            keepListsIfUnsharing: true,
            annotationData: {
                comment: annotationData?.comment ?? '',
                localId: annotationData?.localId,
                color: event.colorId,
            },
            shareOpts: {
                shouldShare:
                    annotationData?.privacyLevel === 200 ? true : false,
                skipPrivacyLevelUpdate: true,
            },
        })

        this.options.annotationsCache.updateAnnotation({
            ...annotationData,
            comment: annotationData?.comment ?? '',
            color: event.color,
            unifiedListIds: annotationData?.unifiedListIds,
        })

        let highlights: HTMLCollection = document.getElementsByTagName(
            'hypothesis-highlight',
        )

        let memexHighlights: Element[] = Array.from(
            highlights,
        ).filter((highlight) =>
            highlight.classList.contains(`memex-highlight-${event.noteId}`),
        )

        for (let item of memexHighlights) {
            item.setAttribute(
                'style',
                `background-color:${RGBAobjectToString(event.color)};`,
            )
            item.setAttribute(
                'highlightcolor',
                `${RGBAobjectToString(event.color)}`,
            )
        }
    }
    saveHighlightColorSettings: EventHandler<
        'saveHighlightColorSettings'
    > = async ({ event, previousState }) => {
        const newState = JSON.parse(event.newState)
        const oldState = JSON.parse(previousState.highlightColors)
        await this.syncSettings.highlightColors.set('highlightColors', newState)

        const changedColors = newState
            .map((newItem, index) => {
                const oldItem = oldState[index]
                if (
                    oldItem &&
                    newItem.id === oldItem.id &&
                    JSON.stringify(newItem.color) !==
                        JSON.stringify(oldItem.color)
                ) {
                    return {
                        id: oldItem.id,
                        oldColor: oldItem.color,
                        newColor: newItem.color,
                    }
                }
            })
            .filter((item) => item != null)

        this.emitMutation({
            highlightColors: { $set: JSON.stringify(newState) },
        })

        let highlights: HTMLCollection = document.getElementsByTagName(
            'hypothesis-highlight',
        )

        for (let color of changedColors) {
            Array.from(highlights).filter((highlight) => {
                if (
                    highlight.getAttribute('highlightcolor') ===
                    RGBAobjectToString(color.oldColor)
                ) {
                    highlight.setAttribute(
                        'style',
                        `background-color:${RGBAobjectToString(
                            color.newColor,
                        )};`,
                    )
                    highlight.setAttribute(
                        'highlightcolor',
                        RGBAobjectToString(color.newColor),
                    )
                }
            })
            const annotationLocalIds: Annotation[] = await this.options.annotationsBG.listAnnotationIdsByColor(
                { color: color.id },
            )

            const annotations = []

            for (let annotation of annotationLocalIds) {
                const annotationCachedData = this.options.annotationsCache.getAnnotationByLocalId(
                    annotation.url,
                )
                if (annotationCachedData) {
                    annotations.push(annotationCachedData)
                }
            }

            for (let annotation of annotations) {
                const colorToUpdate = color.newColor

                this.options.annotationsCache.updateAnnotation({
                    comment: annotation.comment,
                    privacyLevel: annotation.privacyLevel,
                    unifiedListIds: annotation.unifiedListIds,
                    unifiedId: annotation.unifiedId,
                    color: colorToUpdate,
                })
            }
        }
    }

    /** Should only be used for state initialization. */
    private syncCachePageListsState(fullPageUrl: string): void {
        const normalizedPageUrl = normalizeUrl(fullPageUrl)
        const pageListCacheIdsSet =
            this.options.annotationsCache.pageListIds.get(normalizedPageUrl) ??
            new Set()
        this.cachePageListsSubscription(normalizedPageUrl, pageListCacheIdsSet)
    }

    private async setPageActivityState(fullPageUrl: string): Promise<void> {
        const { annotationsCache, pageActivityIndicatorBG } = this.options
        const pageActivity = await pageActivityIndicatorBG.getPageActivityStatus(
            fullPageUrl,
        )

        // Sync page active lists states with sidebar state
        const pageActiveListIds: SidebarContainerState['pageActiveListIds'] = []
        for (const remoteListId of pageActivity.remoteListIds) {
            const listData = annotationsCache.getListByRemoteId(
                remoteListId.toString(),
            )
            if (listData != null) {
                pageActiveListIds.push(listData.unifiedId)
            }
        }

        this.emitMutation({
            pageActiveListIds: { $set: pageActiveListIds },
            pageHasNetworkAnnotations: {
                $set:
                    pageActivity.status === 'has-annotations' ||
                    pageActivity.status === 'no-annotations',
            },
        })
    }

    init: EventHandler<'init'> = async ({ previousState }) => {
        const {
            shouldHydrateCacheOnInit,
            annotationsCache,
            initialState,
            fullPageUrl,
            storageAPI,
            runtimeAPI,
        } = this.options

        const userReference = await this.options.getCurrentUser()
        this.emitMutation({
            currentUserReference: { $set: userReference ?? null },
        })

        this.setupRemoteEventListeners()
        annotationsCache.events.addListener(
            'newAnnotationsState',
            this.cacheAnnotationsSubscription,
        )
        annotationsCache.events.addListener(
            'newListsState',
            this.cacheListsSubscription,
        )
        annotationsCache.events.addListener(
            'updatedPageData',
            this.cachePageListsSubscription,
        )
        // Set initial state, based on what's in the cache (assuming it already has been hydrated)
        this.cacheAnnotationsSubscription(annotationsCache.annotations)
        this.cacheListsSubscription(annotationsCache.lists)

        this.sidebar = document
            .getElementById('memex-sidebar-container')
            ?.shadowRoot.getElementById('annotationSidebarContainer')
        this.readingViewState =
            (await browser.storage.local.get('@Sidebar-reading_view')) ?? true
        // this.readingViewStorageListener(true)

        await loadInitial<SidebarContainerState>(this, async () => {
            this.showState = initialState ?? 'hidden'
            this.emitMutation({
                showState: { $set: initialState ?? 'hidden' },
                loadState: { $set: 'running' },
            })

            if (initialState === 'visible') {
                this.readingViewStorageListener(true)
            }

            if (fullPageUrl == null) {
                return
            }

            this.fullPageUrl = fullPageUrl
            if (shouldHydrateCacheOnInit) {
                await this.hydrateAnnotationsCache(this.fullPageUrl, {
                    renderHighlights: true,
                })
            }
            this.syncCachePageListsState(this.fullPageUrl)
            await this.setPageActivityState(this.fullPageUrl)
        })

        if (isUrlPDFViewerUrl(window.location.href, { runtimeAPI })) {
            const width = SIDEBAR_WIDTH_STORAGE_KEY

            this.emitMutation({
                showState: { $set: 'visible' },
                sidebarWidth: { $set: width },
            })

            setTimeout(async () => {
                await storageAPI.local.set({
                    '@Sidebar-reading_view': true,
                })
            }, 1000)
        }

        const signupDate = new Date(
            await (await this.options.authBG.getCurrentUser()).creationTime,
        ).getTime()

        const openAIKey = await this.syncSettings.openAI.get('apiKey')
        const hasAPIKey = openAIKey && openAIKey.startsWith('sk-')

        this.emitMutation({
            hasKey: { $set: hasAPIKey },
        })
        this.emitMutation({
            signupDate: { $set: signupDate },
            isTrial: { $set: await enforceTrialPeriod30Days(signupDate) },
        })

        await this.checkRabbitHoleOnboardingStage()
    }

    private checkRabbitHoleOnboardingStage = async () => {
        const rabbitHoleBetaAccess = await rabbitHoleBetaFeatureAllowed(
            this.options.authBG,
            this.options.contentScriptsBG,
        )

        this.emitMutation({
            rabbitHoleBetaFeatureAccess: { $set: rabbitHoleBetaAccess },
        })

        if (rabbitHoleBetaAccess === 'onboarded') {
            this.emitMutation({
                rabbitHoleBetaFeatureAccess: { $set: 'onboarded' },
            })
            return 'onboarded'
        }

        if (
            rabbitHoleBetaAccess === 'granted' ||
            rabbitHoleBetaAccess === 'grantedBcOfSubscription'
        ) {
            const url = await downloadMemexDesktop(
                await this.options.pkmSyncBG.getSystemArchAndOS(),
            )

            this.emitMutation({
                desktopAppDownloadLink: { $set: url },
            })
        }
    }

    cleanup = () => {
        this.options.annotationsCache.events.removeListener(
            'newAnnotationsState',
            this.cacheAnnotationsSubscription,
        )
        this.options.annotationsCache.events.removeListener(
            'newListsState',
            this.cacheListsSubscription,
        )
        this.options.annotationsCache.events.removeListener(
            'updatedPageData',
            this.cachePageListsSubscription,
        )
    }

    private cacheListsSubscription: PageAnnotationsCacheEvents['newListsState'] = (
        nextLists,
    ) => {
        this.emitMutation({
            lists: { $set: nextLists },
            listInstances: {
                $apply: (prev: SidebarContainerState['listInstances']) =>
                    fromPairs(
                        normalizedStateToArray(nextLists).map((list) => [
                            list.unifiedId,
                            prev[list.unifiedId] ?? initListInstance(list),
                        ]),
                    ),
            },
            // Ensure conversation states exist for any shared annotation in any shared list
            conversations: {
                $apply: (prev: SidebarContainerState['conversations']) => {
                    return fromPairs(
                        normalizedStateToArray(nextLists)
                            .map((list) => {
                                if (list.remoteId == null) {
                                    return null
                                }
                                return list.unifiedAnnotationIds
                                    .map((annotId) => {
                                        const annotData = this.options
                                            .annotationsCache.annotations.byId[
                                            annotId
                                        ]
                                        if (annotData.remoteId == null) {
                                            return null
                                        }
                                        const conversationId = generateAnnotationCardInstanceId(
                                            list,
                                            annotId,
                                        )
                                        return [
                                            conversationId,
                                            prev[conversationId] ??
                                                getInitialAnnotationConversationState(),
                                        ]
                                    })
                                    .filter((a) => a != null)
                            })
                            .filter((a) => a != null)
                            .flat(),
                    )
                },
            },
        })
    }

    private cachePageListsSubscription: PageAnnotationsCacheEvents['updatedPageData'] = (
        normalizedPageUrl,
        nextPageListIds,
    ) => {
        if (
            this.fullPageUrl &&
            normalizeUrl(this.fullPageUrl) === normalizedPageUrl
        ) {
            this.emitMutation({ pageListIds: { $set: nextPageListIds } })
        }
    }

    private cacheAnnotationsSubscription: PageAnnotationsCacheEvents['newAnnotationsState'] = (
        nextAnnotations,
    ) => {
        this.emitMutation({
            noteCreateState: { $set: 'success' },
            annotations: { $set: nextAnnotations },
            annotationCardInstances: {
                $apply: (
                    prev: SidebarContainerState['annotationCardInstances'],
                ) =>
                    fromPairs(
                        normalizedStateToArray(nextAnnotations)
                            .map((annot) => {
                                const cardIdForMyAnnotsTab = generateAnnotationCardInstanceId(
                                    annot,
                                )

                                return [
                                    ...annot.unifiedListIds
                                        // Don't create annot card instances for foreign lists (won't show up in spaces tab)
                                        .filter(
                                            (unifiedListId) =>
                                                !this.options.annotationsCache
                                                    .lists.byId[unifiedListId]
                                                    ?.isForeignList,
                                        )
                                        .map((unifiedListId) => {
                                            const cardIdForListInstance = generateAnnotationCardInstanceId(
                                                annot,
                                                unifiedListId,
                                            )

                                            return [
                                                cardIdForListInstance,
                                                prev[cardIdForListInstance] ??
                                                    initAnnotationCardInstance(
                                                        annot,
                                                    ),
                                            ]
                                        }),
                                    [
                                        cardIdForMyAnnotsTab,
                                        prev[cardIdForMyAnnotsTab] ??
                                            initAnnotationCardInstance(annot),
                                    ],
                                ]
                            })
                            .flat(),
                    ),
            },
            // Ensure conversation states exist for any shared annotation in any shared list
            conversations: {
                $apply: (prev: SidebarContainerState['conversations']) => {
                    return fromPairs(
                        normalizedStateToArray(nextAnnotations)
                            .map((annot) => {
                                if (annot.remoteId == null) {
                                    return null
                                }
                                return annot.unifiedListIds
                                    .map((listId) => {
                                        const listData = this.options
                                            .annotationsCache.lists.byId[listId]
                                        if (listData.remoteId == null) {
                                            return null
                                        }
                                        const conversationId = generateAnnotationCardInstanceId(
                                            annot,
                                            listId,
                                        )
                                        return [
                                            conversationId,
                                            prev[conversationId] ??
                                                getInitialAnnotationConversationState(),
                                        ]
                                    })
                                    .filter((a) => a != null)
                            })
                            .filter((a) => a != null)
                            .flat(),
                    )
                },
            },
        })
    }

    private readingViewStorageListener = async (enable: boolean) => {
        this.resizeObserver = new ResizeObserver(this.debounceReadingWidth)

        try {
            if (this.readingViewState['@Sidebar-reading_view']) {
                this.emitMutation({
                    readingView: { $set: true },
                })
                this.resizeObserver.observe(this.sidebar)
                window.addEventListener('resize', this.debounceReadingWidth)
                this.setReadingWidth()
            }
            if (!this.readingViewState['@Sidebar-reading_view']) {
                this.emitMutation({
                    readingView: { $set: false },
                })
            }

            const { storageAPI } = this.options
            if (enable) {
                storageAPI.onChanged.addListener(this.toggleReadingView)
            } else {
                storageAPI.onChanged.removeListener(this.toggleReadingView)
                this.resizeObserver.disconnect()
            }
        } catch (e) {
            console.error(e)
        }
    }

    private debounceReadingWidth = throttle(this.setReadingWidth.bind(this), 50)

    private toggleReadingView = (changes: Storage.StorageChange) => {
        for (let key of Object.entries(changes)) {
            if (key[0] === '@Sidebar-reading_view') {
                this.emitMutation({
                    readingView: { $set: key[1].newValue },
                })
                if (key[1].newValue) {
                    this.showState = 'visible'
                    this.setReadingWidth()
                    if (
                        !window.location.href.startsWith(
                            'https://www.youtube.com',
                        )
                    ) {
                        document.body.style.position = 'relative'
                    }
                    if (window.location.href.includes('mail.google.com')) {
                        this.adjustGmailWidth('initial')
                    }
                    this.resizeObserver.observe(this.sidebar)
                    window.addEventListener('resize', this.debounceReadingWidth)
                } else {
                    document.body.style.width = 'initial'
                    document.body.style.position = 'initial'
                    if (document.body.offsetWidth === 0) {
                        document.body.style.width = '100%'
                    }
                    if (window.location.href.includes('mail.google.com')) {
                        this.adjustGmailWidth('initial')
                    }
                    this.resizeObserver.disconnect()
                    window.removeEventListener(
                        'resize',
                        this.debounceReadingWidth,
                    )
                }
            }
        }
    }

    private setReadingWidth() {
        if (this.showState === 'visible') {
            if (!window.location.href.startsWith('https://www.youtube.com')) {
                document.body.style.position = 'relative'
            }
            const sidebar = this.sidebar
            let currentsidebarWidth = sidebar.offsetWidth
            let currentWindowWidth = window.innerWidth
            let readingWidth = currentWindowWidth - currentsidebarWidth - 40

            document.body.style.width = readingWidth + 'px'
            if (window.location.href.includes('mail.google.com')) {
                this.adjustGmailWidth(readingWidth + 'px')
            }
        }
    }

    private adjustGmailWidth(readingWidth) {
        const setMaxWidth = (element: HTMLElement) => {
            element.style.maxWidth = readingWidth
            Array.from(element.children).forEach((child) => {
                setMaxWidth(child as HTMLElement)
            })
        }
        Array.from(document.body.children).forEach((child) => {
            setMaxWidth(child as HTMLElement)
        })
    }

    private async getYoutubeDetails(url) {
        const videoId = new URL(url).searchParams.get('v')
        const isStaging =
            process.env.REACT_APP_FIREBASE_PROJECT_ID?.includes('staging') ||
            process.env.NODE_ENV === 'development'

        const baseUrl = isStaging
            ? 'https://cloudflare-memex-staging.memex.workers.dev'
            : 'https://cloudfare-memex.memex.workers.dev'

        const normalisedYoutubeURL =
            'https://www.youtube.com/watch?v=' + videoId

        const response = await fetch(baseUrl + '/youtube-details', {
            method: 'POST',
            body: JSON.stringify({
                originalUrl: normalisedYoutubeURL,
                getRawTranscript: true,
            }),
            headers: { 'Content-Type': 'application/json' },
        })

        let responseContent = await response.text()

        return responseContent
    }
    private async getTranscriptSection(
        transcriptJSON,
        startTimeSecs,
        endTimeSecs,
    ) {
        const relevantTranscriptItems = transcriptJSON.filter((item) => {
            const flooredStart = Math.floor(item.start)
            const flooredEnd = Math.floor(item.end)

            return (
                (flooredStart >= startTimeSecs &&
                    flooredStart <= endTimeSecs) ||
                (flooredEnd >= startTimeSecs && flooredEnd <= endTimeSecs)
            )
        })

        return relevantTranscriptItems
    }
    private async getYoutubeTranscript(url) {
        const videoId = new URL(url).searchParams.get('v')
        const isStaging =
            process.env.REACT_APP_FIREBASE_PROJECT_ID?.includes('staging') ||
            process.env.NODE_ENV === 'development'

        const baseUrl = isStaging
            ? 'https://cloudflare-memex-staging.memex.workers.dev'
            : 'https://cloudfare-memex.memex.workers.dev'

        const normalisedYoutubeURL =
            'https://www.youtube.com/watch?v=' + videoId

        const response = await fetch(baseUrl + '/youtube-transcripts', {
            method: 'POST',
            body: JSON.stringify({
                originalUrl: normalisedYoutubeURL,
                getRawTranscript: true,
            }),
            headers: { 'Content-Type': 'application/json' },
        })

        let responseContent = await response.text()

        const transcriptJSON = JSON.parse(responseContent).transcriptText

        if (transcriptJSON === null) {
            return null
        }

        return transcriptJSON
    }

    sortAnnotations: EventHandler<'sortAnnotations'> = ({
        event: { sortingFn },
    }) => this.options.annotationsCache.sortAnnotations(sortingFn)

    private async ensureLoggedIn(): Promise<boolean> {
        const {
            authBG,
            setLoginModalShown,
            setDisplayNameModalShown,
        } = this.options

        const user = await authBG.getCurrentUser()
        if (user != null) {
            if (!user.displayName?.length) {
                const userProfile = await authBG.getUserProfile()
                if (!userProfile?.displayName?.length) {
                    setDisplayNameModalShown?.(true)
                    this.emitMutation({
                        showDisplayNameSetupModal: { $set: true },
                    })
                    return false
                }
            }

            setLoginModalShown?.(false)
            setDisplayNameModalShown?.(false)
            this.emitMutation({
                annotationSharingAccess: { $set: 'sharing-allowed' },
            })
            return true
        }

        setLoginModalShown?.(true)
        this.emitMutation({ showLoginModal: { $set: true } })
        return false
    }

    adjustSidebarWidth: EventHandler<'adjustSidebarWidth'> = ({ event }) => {
        this.emitMutation({ sidebarWidth: { $set: event.newWidth } })

        // if (event.isWidthLocked) {
        //     let sidebarWidth = toInteger(event.newWidth?.replace('px', '') ?? 0)
        //     let windowWidth = window.innerWidth
        //     let width = (windowWidth - sidebarWidth).toString()
        //     width = width + 'px'
        //     document.body.style.width = width
        // }
    }

    adjustRighPositionBasedOnRibbonPosition: EventHandler<
        'adjustRighPositionBasedOnRibbonPosition'
    > = ({ event }) => {
        this.emitMutation({
            sidebarRightBorderPosition: { $set: event.position },
        })

        // if (event.isWidthLocked) {
        //     let sidebarWidth = toInteger(event.newWidth?.replace('px', '') ?? 0)
        //     let windowWidth = window.innerWidth
        //     let width = (windowWidth - sidebarWidth).toString()
        //     width = width + 'px'
        //     document.body.style.width = width
        // }
    }

    setPopoutsActive: EventHandler<'setPopoutsActive'> = async ({ event }) => {
        this.emitMutation({
            popoutsActive: { $set: event },
        })
    }
    setAIModel: EventHandler<'setAIModel'> = async ({ event }) => {
        this.emitMutation({
            AImodel: { $set: event },
        })
    }

    show: EventHandler<'show'> = async ({ event }) => {
        this.showState = 'visible'
        this.readingViewState =
            (await browser.storage.local.get('@Sidebar-reading_view')) ?? false
        this.readingViewStorageListener(true)

        let width =
            event.existingWidthState != null
                ? event.existingWidthState
                : SIDEBAR_WIDTH_STORAGE_KEY

        if (!window.location.href.startsWith('https://www.youtube.com')) {
            document.body.style.position = 'relative'
        }

        this.emitMutation({
            showState: { $set: 'visible' },
            sidebarWidth: { $set: width },
        })
    }

    hide: EventHandler<'hide'> = async ({ event, previousState }) => {
        this.showState = 'hidden'
        document.body.style.position = 'initial'
        this.readingViewState =
            (await browser.storage.local.get('@Sidebar-reading_view')) ?? false
        this.readingViewStorageListener(false)
        this.emitMutation({
            showState: { $set: 'hidden' },
            activeAnnotationId: { $set: null },
            readingView: { $set: false },
        })

        document.body.style.width = 'initial'

        if (document.body.offsetWidth === 0) {
            document.body.style.width = '100%'
        }

        if (window.location.href.includes('mail.google.com')) {
            this.adjustGmailWidth('initial')
        }
    }

    lock: EventHandler<'lock'> = () =>
        this.emitMutation({ isLocked: { $set: true } })
    unlock: EventHandler<'unlock'> = () =>
        this.emitMutation({ isLocked: { $set: false } })

    lockWidth: EventHandler<'lockWidth'> = () => {
        // getLocalStorage(SIDEBAR_WIDTH_STORAGE_KEY).then((width) => {
        this.emitMutation({ isWidthLocked: { $set: true } })
    }

    unlockWidth: EventHandler<'unlockWidth'> = () => {
        document.body.style.width = '100%'
        this.emitMutation({ isWidthLocked: { $set: false } })
    }

    copyNoteLink: EventHandler<'copyNoteLink'> = async ({
        event: { link },
    }) => {
        this.options.analytics.trackEvent({
            category: 'ContentSharing',
            action: 'copyNoteLink',
        })

        await this.options.copyToClipboard(link)
    }

    copyPageLink: EventHandler<'copyPageLink'> = async ({
        event: { link },
    }) => {
        this.options.analytics.trackEvent({
            category: 'ContentSharing',
            action: 'copyPageLink',
        })

        await this.options.copyToClipboard(link)
    }

    getAnnotationEditorIntoState: EventHandler<
        'getAnnotationEditorIntoState'
    > = (event) => {
        const editorRef = event

        this.emitMutation({
            annotationCreateEditorRef: { $set: editorRef },
        })
    }

    openWebUIPageForSpace: EventHandler<'openWebUIPageForSpace'> = async ({
        event,
    }) => {
        const listData = this.options.annotationsCache.lists.byId[
            event.unifiedListId
        ]
        if (!listData) {
            throw new Error(
                'Requested space to open in Web UI not found locally',
            )
        }
        if (!listData.remoteId) {
            throw new Error(
                'Requested space to open in Web UI has not been shared',
            )
        }

        let webUIUrl =
            listData.type === 'page-link'
                ? getSinglePageShareUrl({
                      remoteListId: listData.remoteId,
                      remoteListEntryId: listData.sharedListEntryId,
                  })
                : getListShareUrl({
                      remoteListId: listData.remoteId,
                  })

        if (webUIUrl.includes('?') && listData.type === 'page-link') {
            webUIUrl = webUIUrl + '&noAutoOpen=true'
        } else if (listData.type === 'page-link') {
            webUIUrl = webUIUrl + '?noAutoOpen=true'
        }
        window.open(webUIUrl, '_blank')
    }

    openContextMenuForList: EventHandler<'openContextMenuForList'> = async ({
        event,
        previousState,
    }) => {
        const listInstance = previousState.listInstances[event.unifiedListId]
        if (!listInstance) {
            throw new Error(
                'Could not find list instance to open context menu for',
            )
        }

        const nextActiveId =
            previousState.activeListContextMenuId === event.unifiedListId
                ? null
                : event.unifiedListId

        this.emitMutation({ activeListContextMenuId: { $set: nextActiveId } })
    }
    openEditMenuForList: EventHandler<'openEditMenuForList'> = async ({
        event,
        previousState,
    }) => {
        const listInstance = previousState.listInstances[event.unifiedListId]
        if (!listInstance) {
            throw new Error(
                'Could not find list instance to open context menu for',
            )
        }

        const nextActiveId =
            previousState.activeListEditMenuId === event.unifiedListId
                ? null
                : event.unifiedListId

        this.emitMutation({ activeListEditMenuId: { $set: nextActiveId } })
    }

    closePageLinkShareMenu: EventHandler<'closePageLinkShareMenu'> = async ({
        event,
        previousState,
    }) => {
        this.emitMutation({ selectedShareMenuPageLinkList: { $set: null } })
    }

    processFileImportFeeds: EventHandler<'processFileImportFeeds'> = async ({
        event,
        previousState,
    }) => {
        const fileContent = event.fileString
        const parser = new DOMParser()
        const xmlDoc = parser.parseFromString(fileContent, 'text/xml')

        const feedsNode = Array.from(
            xmlDoc.getElementsByTagName('outline'),
        ).filter(
            (node) =>
                node.getAttribute('type') === 'rss' ||
                node.getAttribute('type') === 'atom',
        )
        const feedSources = Array.from(feedsNode).map((node) => ({
            feedTitle: node.getAttribute('title'),
            feedUrl: (
                node.getAttribute('') || node.getAttribute('xmlUrl')
            ).replace('http://', 'https://'),
            feedFavicon: null,
            type: null,
            confirmState: 'success',
        }))

        const allFeedSources = [
            ...feedSources,
            ...previousState.existingFeedSources,
        ]

        this.emitMutation({
            existingFeedSources: {
                $set: allFeedSources,
            },
        })

        await this.options.pkmSyncBG.addFeedSources(feedSources)
    }

    saveFeedSources: EventHandler<'saveFeedSources'> = async ({
        event,
        previousState,
    }) => {
        const sources =
            event.sources?.includes(',') || event.sources?.includes('\n')
                ? event.sources?.split(/[\n,]+/).map((source) => source.trim())
                : [event.sources]

        let feedSourcesToCheck = sources
        if (feedSourcesToCheck?.length === 0) {
            return
        }
        let updatedSources = [...previousState.existingFeedSources]
        const feedSourcePromises = feedSourcesToCheck.map(
            async (inputFeedUrl) => {
                if (
                    !inputFeedUrl ||
                    (inputFeedUrl &&
                        previousState.existingFeedSources.some(
                            (source) => source.feedUrl === inputFeedUrl,
                        ))
                ) {
                    return
                }
                let response
                response = await this.options.pkmSyncBG.checkFeedSource(
                    inputFeedUrl,
                )

                let title = response?.feedTitle ?? null
                let feedUrl = response?.feedUrl

                if (title?.includes('[CDATA')) {
                    title = title.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
                }

                let confirmState
                if (title) {
                    confirmState = 'success'
                } else {
                    confirmState = 'error'
                }

                const updatedSource = {
                    feedTitle: title ?? feedUrl,
                    feedUrl: feedUrl,
                    type: null,
                    confirmState: confirmState,
                    feedFavIcon: null,
                }

                // Find the index of the existing source with the same feedUrl
                const existingSourceIndex = updatedSources.findIndex(
                    (src) => src.feedUrl === feedUrl,
                )

                // If the source does not exist in the updatedSources array, add it to the beginning
                if (
                    existingSourceIndex === -1 &&
                    updatedSource.feedUrl &&
                    updatedSource.feedTitle
                ) {
                    updatedSources.unshift(updatedSource)
                } else {
                    // If the source already exists, do not add it again
                    return
                }

                this.emitMutation({
                    existingFeedSources: { $set: updatedSources },
                })

                return updatedSource
            },
        )
        let results

        try {
            results = await Promise.all(feedSourcePromises)

            results = results?.filter(
                (result) => result != null && result.confirmState !== 'error',
            )
        } catch (e) {
            console.log('e', e)
        }

        // // Remove duplicates from updatedSources based on feedUrl
        // updatedSources = updatedSources.reduce((unique, item) => {
        //     // If the feedUrl already exists in the unique array, return the unique array as is
        //     return unique.some((feed) => feed.feedUrl === item.feedUrl)
        //         ? unique
        //         : // If the feedUrl does not exist in the unique array, add the item to the unique array
        //           [...unique, item]
        // }, [])

        // this.emitMutation({
        //     existingFeedSources: { $set: updatedSources },
        // })
        await this.options.pkmSyncBG.addFeedSources(results)
    }
    loadFeedSources: EventHandler<'loadFeedSources'> = async ({
        event,
        previousState,
    }) => {
        const feedSources = await this.options.pkmSyncBG.loadFeedSources()

        this.emitMutation({
            existingFeedSources: { $set: feedSources },
        })
    }
    removeFeedSource: EventHandler<'removeFeedSource'> = async ({
        event,
        previousState,
    }) => {
        const feedUrl = event.feedUrl

        let currentSources = previousState.existingFeedSources

        // Find the index of the folder with the id = event.id
        const feedIndex = currentSources.findIndex(
            (folder) => folder.feedUrl === feedUrl,
        )

        // If the folder is found, remove it from the array
        if (feedIndex !== -1) {
            currentSources.splice(feedIndex, 1)
        }

        this.emitMutation({
            existingFeedSources: { $set: currentSources },
        })
        await this.options.pkmSyncBG.removeFeedSource(feedUrl)
    }

    validateSpaceName(name: string, listIdToSkip?: number) {
        const validationResult = validateSpaceName(
            name,
            normalizedStateToArray(this.options.annotationsCache.lists).map(
                (entry) => ({
                    id: entry.localId,
                    name: entry.name,
                }),
            ),
            { listIdToSkip },
        )

        this.emitMutation({
            renameListErrorMessage: {
                $set:
                    validationResult.valid === false
                        ? validationResult.reason
                        : null,
            },
        })

        return validationResult
    }

    __getListDataByLocalId = (
        localId: number,
        { annotationsCache }: Pick<SpacePickerDependencies, 'annotationsCache'>,
        opts?: {
            source?: keyof SpacePickerEvent
            mustBeLocal?: boolean
        },
    ): UnifiedList => {
        const listData = annotationsCache.getListByLocalId(localId)
        const source = opts?.source ? `for ${opts.source} ` : ''

        if (!listData) {
            throw new Error(`Specified list data ${source}could not be found`)
        }
        if (opts?.mustBeLocal && listData.localId == null) {
            throw new Error(
                `Specified list data ${source}could not be found locally`,
            )
        }
        return listData
    }

    setRabbitHoleBetaFeatureAccess: EventHandler<
        'setRabbitHoleBetaFeatureAccess'
    > = async ({ event }) => {
        if (event.permission === 'onboarding') {
            const url = await downloadMemexDesktop(
                await this.options.pkmSyncBG.getSystemArchAndOS(),
            )
            this.emitMutation({
                rabbitHoleBetaFeatureAccess: { $set: event.permission },
            })

            this.emitMutation({
                desktopAppDownloadLink: { $set: url },
            })
        }

        if (event.permission === 'downloadStarted') {
            this.emitMutation({
                rabbitHoleBetaFeatureAccess: {
                    $set: 'downloadStarted',
                },
            })
            const desktopAppRunning = await this.checkIfDesktopAppIsRunning()
            if (desktopAppRunning) {
                this.emitMutation({
                    rabbitHoleBetaFeatureAccess: {
                        $set: 'helperConnectionSuccess',
                    },
                })
            }
        }

        if (event.permission === 'onboarded') {
            this.emitMutation({
                rabbitHoleBetaFeatureAccess: {
                    $set: 'onboarded',
                },
            })
            await browser.storage.local.set({
                rabbitHoleBetaFeatureAccessOnboardingDone: true,
            })
        }
    }

    async checkIfDesktopAppIsRunning(onetimeCheck?: boolean) {
        let isConnected = false
        let counter = 0
        while (!isConnected && counter < 3000) {
            counter++
            await new Promise((resolve) => setTimeout(resolve, 1000))
            let backend
            try {
                backend = await this.options.pkmSyncBG.checkConnectionStatus()
            } catch (e) {
                console.error(
                    'Trying to connect to Desktop App but not yet available',
                )
            }
            if (backend) {
                isConnected = true
                return true
            } else if (onetimeCheck && isConnected === false) {
                return false
            }
        }
    }

    requestRabbitHoleBetaFeatureAccess: EventHandler<
        'requestRabbitHoleBetaFeatureAccess'
    > = async ({ event }) => {
        this.emitMutation({
            rabbitHoleBetaFeatureAccess: { $set: null },
        })

        const isStaging =
            process.env.REACT_APP_FIREBASE_PROJECT_ID?.includes('staging') ||
            process.env.NODE_ENV === 'development'

        const email = (await this.options.authBG.getCurrentUser())?.email
        const userId = (await this.options.authBG.getCurrentUser())?.id

        const baseUrl = isStaging
            ? 'https://cloudflare-memex-staging.memex.workers.dev'
            : 'https://cloudfare-memex.memex.workers.dev'

        await fetch(baseUrl + '/subscribe_rabbithole_waitlist', {
            method: 'POST',
            body: JSON.stringify({
                email: email,
                userId: userId,
                reasonText: event.reasonText,
            }),
            headers: { 'Content-Type': 'application/json' },
        })

        const onboardingStage = await rabbitHoleBetaFeatureAllowed(
            this.options.authBG,
            this.options.contentScriptsBG,
        )

        this.emitMutation({
            rabbitHoleBetaFeatureAccess: { $set: onboardingStage },
        })
    }

    setListPrivacy: EventHandler<'setListPrivacy'> = async ({ event }) => {
        const { annotationsCache, contentSharingBG } = this.options
        const list = annotationsCache.lists.byId[event.unifiedListId]
        if (list?.localId == null) {
            throw new Error('Tried to set privacy for non-cached list')
        }
        annotationsCache.updateList({
            unifiedId: event.unifiedListId,
            isPrivate: event.isPrivate,
        })
        await contentSharingBG.updateListPrivacy({
            localListId: list.localId,
            isPrivate: event.isPrivate,
        })
    }

    editListName: EventHandler<'editListName'> = async ({ event }) => {
        const newName = event.newName.trim()
        const listData = this.__getListDataByLocalId(
            event.localId,
            this.options,
            { source: 'renameList', mustBeLocal: true },
        )
        if (listData.name === newName) {
            return
        }
        const validationResult = this.validateSpaceName(newName)
        if (validationResult.valid === false) {
            this.emitMutation({
                renameListErrorMessage: {
                    $set: validationResult.reason,
                },
            })
            return
        }

        this.options.annotationsCache.updateList({
            unifiedId: event.unifiedListId,
            name: newName,
        })

        await this.options.customListsBG.updateListName({
            id: event.localId,
            oldName: event.oldName,
            newName,
        })
    }

    deleteList: EventHandler<'deleteList'> = async ({ event }) => {
        this.options.annotationsCache.removeList({
            unifiedId: event.unifiedListId,
        })
    }

    setPillVisibility: EventHandler<'setPillVisibility'> = async ({
        event,
    }) => {
        this.emitMutation({
            pillVisibility: { $set: event.value },
        })
    }

    paginateSearch: EventHandler<'paginateSearch'> = async ({
        previousState,
    }) => {
        if (previousState.noResults) {
            return
        }

        const mutation: UIMutation<SidebarContainerState> = {
            searchResultSkip: {
                $apply: (prev) => prev + this.resultLimit,
            },
        }
        this.emitMutation(mutation)
        const nextState = this.withMutation(previousState, mutation)

        // await this.doSearch(nextState, { overwrite: false })
    }

    setPageUrl: EventHandler<'setPageUrl'> = async ({
        previousState,
        event,
    }) => {
        if (!isFullUrl(event.fullPageUrl)) {
            throw new Error(
                'Tried to set annotation sidebar with a normalized page URL',
            )
        }

        if (previousState.fullPageUrl === event.fullPageUrl) {
            return
        }

        this.syncCachePageListsState(event.fullPageUrl)
        await this.setPageActivityState(event.fullPageUrl)

        this.fullPageUrl = event.fullPageUrl
        this.emitMutation({ fullPageUrl: { $set: event.fullPageUrl } })
        await this.hydrateAnnotationsCache(event.fullPageUrl, {
            renderHighlights: event.rerenderHighlights,
        })

        if (previousState.activeTab === 'spaces') {
            await this.loadRemoteAnnototationReferencesForCachedLists(
                previousState,
            )
        }
        if (previousState.activeTab === 'summary') {
            this.emitMutation({
                prompt: { $set: undefined },
            })
            await this.queryAI(
                event.fullPageUrl,
                undefined,
                undefined,
                previousState,
                undefined,
            )
        }
    }

    setAllNotesShareMenuShown: EventHandler<
        'setAllNotesShareMenuShown'
    > = async ({ previousState, event }) => {
        this.emitMutation({
            showAllNotesShareMenu: { $set: event.shown },
        })
    }

    setLoginModalShown: EventHandler<'setLoginModalShown'> = ({ event }) => {
        this.emitMutation({ showLoginModal: { $set: event.shown } })
    }

    setDisplayNameSetupModalShown: EventHandler<
        'setDisplayNameSetupModalShown'
    > = ({ event }) => {
        this.emitMutation({ showDisplayNameSetupModal: { $set: event.shown } })
    }

    setAllNotesCopyPasterShown: EventHandler<'setAllNotesCopyPasterShown'> = ({
        event,
    }) => {
        this.emitMutation({
            showAllNotesCopyPaster: { $set: event.shown },
        })
    }

    // TODO: type properly
    private applyStateMutationForAllFollowedLists = (
        previousState: SidebarContainerState,
        mutation: UIMutation<any>,
    ): UIMutation<any> => ({
        // followedLists: {
        //     byId: previousState.followedLists.allIds.reduce(
        //         (acc, listId) => ({
        //             ...acc,
        //             [listId]: { ...mutation },
        //         }),
        //         {},
        //     ),
        // },
    })

    /* -- START: Annotation card instance events -- */
    setAnnotationEditMode: EventHandler<'setAnnotationEditMode'> = async ({
        previousState,
        event,
    }) => {
        if (event.instanceLocation === 'annotations-tab') {
            if (previousState.activeTab !== 'annotations') {
                this.emitMutation({
                    activeTab: { $set: 'annotations' },
                })
            }
        } else {
            this.emitMutation({
                activeTab: { $set: 'spaces' },
            })
        }

        this.emitMutation({
            annotationCardInstances: {
                [getAnnotCardInstanceId(event)]: {
                    isCommentEditing: { $set: event.isEditing },
                },
            },
        })
    }

    cancelAnnotationEdit: EventHandler<'cancelAnnotationEdit'> = ({
        previousState,
        event,
    }) => {
        const previousAnnotationComment = this.options.annotationsCache
            .annotations.byId[event.unifiedAnnotationId].comment

        this.emitMutation({
            annotationCardInstances: {
                [getAnnotCardInstanceId(event)]: {
                    isCommentEditing: { $set: false },
                    comment: { $set: previousAnnotationComment },
                },
            },
        })
    }

    setAnnotationEditCommentText: EventHandler<
        'setAnnotationEditCommentText'
    > = async ({ event }) => {
        let annotation = event.annotation

        let newComment = (
            await processCommentForImageUpload(
                event.comment,
                annotation.normalizedPageUrl,
                annotation.localId,
                this.options.imageSupport,
                true,
            )
        ).toString()

        this.emitMutation({
            annotationCardInstances: {
                [getAnnotCardInstanceId(event)]: {
                    comment: { $set: newComment },
                },
            },
        })
    }

    setAnnotationCommentMode: EventHandler<'setAnnotationCommentMode'> = ({
        event,
    }) => {
        this.emitMutation({
            annotationCardInstances: {
                [getAnnotCardInstanceId(event)]: {
                    isCommentTruncated: { $set: event.isTruncated },
                },
            },
        })
    }

    setAnnotationCardMode: EventHandler<'setAnnotationCardMode'> = ({
        event,
    }) => {
        this.emitMutation({
            annotationCardInstances: {
                [getAnnotCardInstanceId(event)]: {
                    cardMode: { $set: event.mode },
                },
            },
        })
    }

    editAnnotation: EventHandler<'editAnnotation'> = async ({
        event,
        previousState,
    }) => {
        const cardId = getAnnotCardInstanceId(event)
        const {
            annotationCardInstances: { [cardId]: formData },
            annotations: {
                byId: { [event.unifiedAnnotationId]: annotationData },
            },
        } = previousState

        if (
            !formData ||
            annotationData?.creator?.id !== this.options.getCurrentUser()?.id ||
            (event.shouldShare && !(await this.ensureLoggedIn()))
        ) {
            return
        }

        const now = event.now ?? Date.now()
        const comment = sanitizeHTMLhelper(formData.comment.trim())
        const hasCoreAnnotChanged = comment !== annotationData.comment

        let commentForSaving = await processCommentForImageUpload(
            comment,
            annotationData.normalizedPageUrl,
            annotationData.localId,
            this.options.imageSupport,
        )

        // If the main save button was pressed, then we're not changing any share state, thus keep the old lists
        // NOTE: this distinction exists because of the SAS state being implicit and the logic otherwise thinking you want
        //  to make a SAS annotation private protected upon save btn press
        // TODO: properly update lists state
        // existing.lists = event.mainBtnPressed
        //     ? existing.lists
        //     : this.getAnnotListsAfterShareStateChange({
        //           previousState,
        //           annotationIndex,
        //           keepListsIfUnsharing: event.keepListsIfUnsharing,
        //           incomingPrivacyState: {
        //               public: event.shouldShare,
        //               protected: !!event.isProtected,
        //           },
        //       })

        const { remoteAnnotationId, savePromise } = await updateAnnotation({
            annotationsBG: this.options.annotationsBG,
            contentSharingBG: this.options.contentSharingBG,
            keepListsIfUnsharing: event.keepListsIfUnsharing,
            annotationData: {
                comment:
                    commentForSaving !== annotationData.comment
                        ? commentForSaving
                        : null,
                localId: annotationData.localId,
            },
            shareOpts: {
                shouldShare: event.shouldShare,
                shouldCopyShareLink: event.shouldShare,
                isBulkShareProtected:
                    event.isProtected || !!event.keepListsIfUnsharing,
                skipPrivacyLevelUpdate: event.mainBtnPressed,
            },
        })

        this.options.annotationsCache.updateAnnotation(
            {
                ...annotationData,
                comment: comment,
                remoteId: remoteAnnotationId ?? undefined,
                privacyLevel: shareOptsToPrivacyLvl({
                    shouldShare: event.shouldShare,
                    isBulkShareProtected:
                        event.isProtected || !!event.keepListsIfUnsharing,
                }),
            },
            { updateLastEditedTimestamp: hasCoreAnnotChanged, now },
        )

        this.emitMutation({
            annotationCardInstances: {
                [cardId]: {
                    isCommentEditing: { $set: false },
                },
            },
            confirmPrivatizeNoteArgs: {
                $set: null,
            },
        })

        await savePromise
    }

    setSpacePickerAnnotationInstance: EventHandler<
        'setSpacePickerAnnotationInstance'
    > = async ({ event }) => {
        this.emitMutation({
            spacePickerAnnotationInstance: { $set: event.state },
        })
    }

    setCopyPasterAnnotationInstanceId: EventHandler<
        'setCopyPasterAnnotationInstanceId'
    > = async ({ event }) => {
        this.emitMutation({
            copyPasterAnnotationInstanceId: { $set: event.instanceId },
        })
    }

    setShareMenuAnnotationInstanceId: EventHandler<
        'setShareMenuAnnotationInstanceId'
    > = async ({ event }) => {
        this.emitMutation({
            shareMenuAnnotationInstanceId: { $set: event.instanceId },
        })
    }
    /* -- END: Annotation card instance events -- */

    receiveSharingAccessChange: EventHandler<'receiveSharingAccessChange'> = ({
        event: { sharingAccess },
    }) => {
        this.emitMutation({ annotationSharingAccess: { $set: sharingAccess } })
    }

    cancelNewPageNote: EventHandler<'cancelNewPageNote'> = () => {
        this.emitMutation({
            commentBox: { $set: INIT_FORM_STATE },
            showCommentBox: { $set: false },
        })
    }

    createNewNoteFromAISummary: EventHandler<
        'createNewNoteFromAISummary'
    > = async ({ event }) => {
        const comment = '<div>' + marked.parse(event.comment) + '</div>'
        this.emitMutation({
            activeTab: { $set: 'annotations' },
            commentBox: {
                commentText: { $set: comment },
            },
        })
        this.options.focusCreateForm()
    }

    setNewPageNoteText: EventHandler<'setNewPageNoteText'> = async ({
        event,
    }) => {
        this.emitMutation({
            showCommentBox: { $set: true },
            commentBox: {
                commentText: { $set: event.comment },
            },
        })

        this.options.focusCreateForm()
    }

    saveNewPageNote: EventHandler<'saveNewPageNote'> = async ({
        event,
        previousState,
    }) => {
        const {
            lists,
            commentBox,
            fullPageUrl,
            selectedListId,
            activeTab,
        } = previousState

        let OriginalCommentForCache = commentBox.commentText.trim()
        OriginalCommentForCache = sanitizeHTMLhelper(OriginalCommentForCache)
        if (OriginalCommentForCache.length === 0) {
            return
        }

        let syncSettings: SyncSettingsStore<'extension'>

        syncSettings = createSyncSettingsStore({
            syncSettingsBG: this.options.syncSettingsBG,
        })

        const shouldShareSettings = await syncSettings.extension.get(
            'shouldAutoAddSpaces',
        )

        const now = event.now ?? Date.now()
        const annotationId =
            event.annotationId ??
            generateAnnotationUrl({
                pageUrl: fullPageUrl,
                now: () => now,
            })

        // this checks for all images in the comment that have not been uploaded yet, uploads them and gives back an updated version of the html code.
        // however the original comment is put in cache
        let commentForSaving = await processCommentForImageUpload(
            OriginalCommentForCache,
            normalizeUrl(fullPageUrl),
            annotationId,
            this.options.imageSupport,
        )

        this.emitMutation({
            commentBox: { $set: INIT_FORM_STATE },
            showCommentBox: { $set: false },
        })

        await executeUITask(this, 'noteCreateState', async () => {
            if (event.shouldShare && !(await this.ensureLoggedIn())) {
                return
            }
            // A bunch of side-effects occur based on the types of lists this annotation will be a part of, and there's
            //  a bunch of different IDs for lists, thus we gotta group these here to decide things further on in this logic
            const remoteListIds: string[] = []
            const localListIds = [...commentBox.lists]
            const unifiedListIds: UnifiedList['unifiedId'][] = []
            const maybeAddLocalListIdForCacheList = (
                unifiedListId?: UnifiedList['unifiedId'],
            ) => {
                if (unifiedListId == null) {
                    return
                }

                const { localId, remoteId } = lists.byId[unifiedListId]
                if (localId != null) {
                    localListIds.push(localId)
                }
                if (remoteId != null) {
                    remoteListIds.push(remoteId)
                }
                unifiedListIds.push(unifiedListId)
            }

            let title: string | null = null
            if (window.location.href.includes('web.telegram.org')) {
                title = getTelegramUserDisplayName(
                    document,
                    window.location.href,
                )
            }

            if (
                window.location.href.includes('x.com/messages/') ||
                window.location.href.includes('twitter.com/messages/')
            ) {
                title = document.title
            }

            // Adding a new annot in selected space mode should only work on the "Spaces" tab
            if (activeTab === 'spaces') {
                maybeAddLocalListIdForCacheList(selectedListId)
            }
            maybeAddLocalListIdForCacheList(event.listInstanceId)

            let privacyLevel: AnnotationPrivacyLevels
            if (previousState.selectedListId) {
                privacyLevel = event.shouldShare
                    ? AnnotationPrivacyLevels.SHARED
                    : AnnotationPrivacyLevels.PROTECTED
            } else {
                privacyLevel =
                    shouldShareSettings || event.shouldShare
                        ? AnnotationPrivacyLevels.SHARED
                        : AnnotationPrivacyLevels.PRIVATE
            }

            const { remoteAnnotationId, savePromise } = await createAnnotation({
                annotationData: {
                    comment: commentForSaving,
                    fullPageUrl,
                    localListIds,
                    localId: annotationId,
                    createdWhen: new Date(now),
                    pageTitle: title,
                },
                syncSettingsBG: this.options.syncSettingsBG,
                annotationsBG: this.options.annotationsBG,
                contentSharingBG: this.options.contentSharingBG,
                skipListExistenceCheck:
                    previousState.hasListDataBeenManuallyPulled,
                privacyLevelOverride: privacyLevel,
                shareOpts: {
                    shouldShare:
                        shouldShareSettings ||
                        remoteListIds.length > 0 ||
                        event.shouldShare,
                    shouldCopyShareLink: event.shouldShare,
                    isBulkShareProtected: event.isProtected,
                },
            })

            this.options.annotationsCache.addAnnotation({
                localId: annotationId,
                remoteId: remoteAnnotationId ?? undefined,
                normalizedPageUrl: normalizeUrl(fullPageUrl),
                creator: this.options.getCurrentUser(),
                createdWhen: now,
                lastEdited: now,
                privacyLevel,
                // These only contain lists added in the UI dropdown (to be checked in case any are shared, which should influence the annot privacy level)
                localListIds: [...commentBox.lists],
                unifiedListIds, // These contain the context list (selected list or list instance)
                comment: OriginalCommentForCache,
            })

            if (remoteAnnotationId != null && remoteListIds.length > 0) {
                this.emitMutation({
                    conversations: {
                        $merge: fromPairs(
                            remoteListIds.map((remoteId) => [
                                this.buildConversationId(remoteAnnotationId, {
                                    type: 'shared-list-reference',
                                    id: remoteId,
                                }),
                                getInitialAnnotationConversationState(),
                            ]),
                        ),
                    },
                })
            }

            await savePromise
        })
    }

    updateListsForAnnotation: EventHandler<
        'updateListsForAnnotation'
    > = async ({ event }) => {
        const { annotationsCache, contentSharingBG } = this.options

        // this.emitMutation({ confirmSelectNoteSpaceArgs: { $set: null } })

        const existing =
            annotationsCache.annotations.byId[event.unifiedAnnotationId]
        if (!existing) {
            console.warn(
                "Attempted to update lists for annotation that isn't cached:",
                event,
                annotationsCache,
            )
            return
        }
        if (!existing.localId) {
            console.warn(
                `Attempted to update lists for annotation that isn't owned:`,
                event,
                annotationsCache,
            )
            return
        }

        const unifiedListIds = new Set(existing.unifiedListIds)
        let bgPromise: Promise<{ sharingState: AnnotationSharingState }>
        if (event.added != null) {
            const cacheList = annotationsCache.getListByLocalId(event.added)
            if (!cacheList) {
                throw new Error(
                    'Cannot find list to add to annotation in cache',
                )
            }

            // Ensure any added shared list becomes part of the page lists
            if (cacheList.remoteId != null) {
                const pageUrl = normalizeUrl(this.fullPageUrl)
                const pageListsSet =
                    annotationsCache.pageListIds.get(pageUrl) ?? new Set()
                pageListsSet.add(cacheList.unifiedId)
                annotationsCache.setPageData(pageUrl, Array.from(pageListsSet))
            }

            unifiedListIds.add(cacheList.unifiedId)
            bgPromise = contentSharingBG.shareAnnotationToSomeLists({
                annotationUrl: existing.localId,
                localListIds: [event.added],
                protectAnnotation: true,
            })
        } else if (event.deleted != null) {
            const cacheList = annotationsCache.getListByLocalId(event.deleted)
            if (!cacheList) {
                throw new Error(
                    'Cannot find list to remove from annotation in cache',
                )
            }

            unifiedListIds.delete(cacheList.unifiedId)
            bgPromise = contentSharingBG.unshareAnnotationFromList({
                annotationUrl: existing.localId,
                localListId: event.deleted,
            })
        }

        annotationsCache.updateAnnotation(
            {
                comment: existing.comment,
                remoteId: existing.remoteId,
                unifiedListIds: [...unifiedListIds],
                unifiedId: event.unifiedAnnotationId,
                privacyLevel: existing.privacyLevel,
            },
            { keepListsIfUnsharing: event.options?.protectAnnotation },
        )

        const { sharingState } = await bgPromise

        // Update again with the calculated lists and privacy lvl from the BG ops (TODO: there's gotta be a nicer way to handle this optimistically in the UI)
        annotationsCache.updateAnnotation(
            {
                comment: existing.comment,
                remoteId: sharingState.remoteId
                    ? sharingState.remoteId.toString()
                    : existing.remoteId,
                unifiedId: event.unifiedAnnotationId,
                privacyLevel: sharingState.privacyLevel,
                unifiedListIds: [
                    ...sharingState.privateListIds,
                    ...sharingState.sharedListIds,
                ]
                    .map(
                        (localListId) =>
                            annotationsCache.getListByLocalId(localListId)
                                ?.unifiedId,
                    )
                    .filter((id) => !!id),
            },
            { forceListUpdate: true },
        )
    }

    setNewPageNoteLists: EventHandler<'setNewPageNoteLists'> = async ({
        event,
        previousState,
    }) => {
        this.emitMutation({
            commentBox: { lists: { $set: event.lists } },
        })
    }

    goToAnnotationInNewTab: EventHandler<'goToAnnotationInNewTab'> = async ({
        event,
    }) => {
        this.emitMutation({
            activeAnnotationId: { $set: event.unifiedAnnotationId },
        })

        const annotation = this.options.annotationsCache.annotations.byId[
            event.unifiedAnnotationId
        ]

        if (!annotation) {
            throw new Error(
                `Could not find cached annotation data for ID: ${event.unifiedAnnotationId}`,
            )
        }

        let fullPageURL = 'https://' + annotation.normalizedPageUrl

        if (fullPageURL.includes('web.telegram.org')) {
            fullPageURL = convertMemexURLintoTelegramURL(fullPageURL)
        }
        return this.options.contentScriptsBG.goToAnnotationFromDashboardSidebar(
            {
                fullPageUrl: fullPageURL,
                annotationCacheId: annotation.localId,
            },
        )
    }

    deleteAnnotation: EventHandler<'deleteAnnotation'> = async ({ event }) => {
        const { annotationsCache, annotationsBG } = this.options
        const existing =
            annotationsCache.annotations.byId[event.unifiedAnnotationId]
        annotationsCache.removeAnnotation({
            unifiedId: event.unifiedAnnotationId,
        })

        if (existing?.localId != null) {
            await annotationsBG.deleteAnnotation(existing.localId)
        }
    }

    setActiveAnnotation: EventHandler<'setActiveAnnotation'> = async ({
        event,
        previousState,
    }) => {
        let unifiedAnnotation
        for (const id in this.options.annotationsCache.annotations.byId) {
            if (
                this.options.annotationsCache.annotations.byId[id].unifiedId ===
                    event.unifiedAnnotationId ||
                this.options.annotationsCache.annotations.byId[id].localId ===
                    event.unifiedAnnotationId
            ) {
                unifiedAnnotation = this.options.annotationsCache.annotations
                    .byId[id]
                break
            }
        }

        const unifiedAnnotationId = unifiedAnnotation?.unifiedId

        this.emitMutation({
            activeAnnotationId: { $set: unifiedAnnotationId },
        })

        const cachedAnnotation = this.options.annotationsCache.annotations.byId[
            unifiedAnnotationId
        ]
        if (event.source === 'highlightCard') {
            if (cachedAnnotation?.selector != null) {
                this.options.events?.emit('highlightAndScroll', {
                    highlight: cachedAnnotation,
                })
            }
        }

        if (!event.mode) {
            return
        }
        const location = previousState.selectedListId ?? undefined
        const cardId = generateAnnotationCardInstanceId(
            {
                unifiedId: unifiedAnnotationId,
            },
            location,
        )

        // Likely a highlight for another user's annotation, thus non-existent in "annotations" tab
        if (previousState.annotationCardInstances[cardId] == null) {
            return
        }

        if (event.mode === 'edit') {
            this.emitMutation({
                annotationCardInstances: {
                    [cardId]: { isCommentEditing: { $set: true } },
                },
            })
        } else if (event.mode === 'edit_spaces') {
            this.emitMutation({
                annotationCardInstances: {
                    [cardId]: { cardMode: { $set: 'space-picker' } },
                },
            })
        }
    }

    setAnnotationsExpanded: EventHandler<'setAnnotationsExpanded'> = (
        incoming,
    ) => {}

    fetchSuggestedTags: EventHandler<'fetchSuggestedTags'> = (incoming) => {}

    fetchSuggestedDomains: EventHandler<'fetchSuggestedDomains'> = (
        incoming,
    ) => {}

    private async loadRemoteAnnototationReferencesForCachedLists(
        state: SidebarContainerState,
    ): Promise<void> {
        const listsWithRemoteAnnots = normalizedStateToArray(
            this.options.annotationsCache.lists,
        ).filter(
            (list) =>
                list.hasRemoteAnnotationsToLoad &&
                list.remoteId != null &&
                state.listInstances[list.unifiedId]?.annotationRefsLoadState ===
                    'pristine', // Ensure it hasn't already been loaded
        )

        const nextState = await this.loadRemoteAnnotationReferencesForSpecificLists(
            state,
            listsWithRemoteAnnots,
        )
        this.renderOpenSpaceInstanceHighlights(nextState)
    }

    private async loadRemoteAnnotationReferencesForSpecificLists(
        state: SidebarContainerState,
        lists: UnifiedList[],
    ): Promise<SidebarContainerState> {
        let nextState = state
        if (!lists.length) {
            return nextState
        }

        await executeUITask(
            this,
            (taskState) => ({
                listInstances: fromPairs(
                    lists.map((list) => [
                        list.unifiedId,
                        { annotationRefsLoadState: { $set: taskState } },
                    ]),
                ),
            }),
            async () => {
                const response = await this.options.customListsBG.fetchAnnotationRefsForRemoteListsOnPage(
                    {
                        normalizedPageUrl: normalizeUrl(state.fullPageUrl),
                        sharedListIds: lists.map((list) => list.remoteId!),
                    },
                )

                const mutation: UIMutation<
                    SidebarContainerState['listInstances']
                > = {}

                for (const { unifiedId, remoteId } of lists) {
                    const result = response[remoteId]
                    if (result?.status === 'success') {
                        mutation[unifiedId] = {
                            sharedAnnotationReferences: { $set: result.data },
                        }
                    } else {
                        // TODO: Handle non-success cases in UI
                    }
                }

                nextState = this.applyAndEmitMutation(nextState, {
                    listInstances: mutation,
                })
            },
        )
        return nextState
    }

    async queryAI(
        fullPageUrl,
        highlightedText,
        prompt?,
        previousState?: SidebarContainerState,
        textAsAlternative?: string,
        outputLocation?:
            | 'editor'
            | 'summaryContainer'
            | 'chapterSummary'
            | null,
        chapterSummaryIndex?: number,
    ) {
        this.emitMutation({
            loadState: { $set: 'running' },
        })

        const selectedText =
            highlightedText || previousState?.selectedTextAIPreview

        const isPagePDF =
            fullPageUrl && fullPageUrl.includes('/pdfjs/viewer.html?')
        const openAIKey = await this.syncSettings.openAI.get('apiKey')
        const hasAPIKey = openAIKey && openAIKey.startsWith('sk-')

        if (!hasAPIKey) {
            let canQueryAI = false
            if (previousState.isTrial) {
                canQueryAI = true
            } else if (await AIActionAllowed(this.options.analyticsBG)) {
                canQueryAI = true
            }
            if (!canQueryAI) {
                this.emitMutation({
                    showUpgradeModal: { $set: true },
                })
                return
            }
        }

        let queryPrompt = prompt

        if (!previousState.isTrial) {
            await updateAICounter()
        }
        this.emitMutation({
            selectedTextAIPreview: {
                $set:
                    selectedText?.length && outputLocation !== 'chapterSummary'
                        ? selectedText
                        : null,
            },
            loadState: {
                $set:
                    outputLocation !== 'editor' &&
                    outputLocation !== 'chapterSummary'
                        ? 'running'
                        : 'pristine',
            },
            prompt: {
                $set:
                    outputLocation !== 'chapterSummary'
                        ? prompt
                        : previousState.prompt,
            },
            showAICounter: { $set: true },
            hasKey: { $set: hasAPIKey },
        })

        let textToAnalyse
        let isContentSearch = false
        textToAnalyse = textAsAlternative
            ? textAsAlternative
            : selectedText
            ? selectedText
            : null

        if (previousState.fetchLocalHTML) {
            textToAnalyse = document.title + document.body.innerText
        }

        if (
            previousState.activeAITab === 'ExistingKnowledge' ||
            previousState.activeAITab === 'InFollowedFeeds'
        ) {
            if (previousState.prompt?.length === 0 && prompt.length === 0) {
                this.emitMutation({
                    loadState: { $set: 'success' },
                })
                return
            }
            const results = await this.options.customListsBG.findSimilarBackground(
                previousState.prompt || prompt,
                normalizeUrl(
                    this.previousState?.fullPageUrl || this.fullPageUrl,
                    {
                        skipProtocolTrim: true,
                    },
                ),
            )

            if (results.length === 0) {
                this.emitMutation({
                    loadState: { $set: 'success' },
                    pageSummary: { $set: 'No references to analyse' },
                })
                return
            }

            let extractedData

            if (previousState.activeAITab === 'ExistingKnowledge') {
                this.emitMutation({
                    activeSuggestionsTab: { $set: 'MySuggestions' },
                })

                extractedData = results.filter((result) => {
                    return (
                        result.creatorId ===
                            previousState.currentUserReference.id ||
                        result.creatorId === '1'
                    )
                })

                extractedData = extractedData.map((result) => {
                    return {
                        pageTitle: result.pageTitle,
                        contentText: result.contentText,
                    }
                })
            }
            if (previousState.activeAITab === 'InFollowedFeeds') {
                this.emitMutation({
                    activeSuggestionsTab: { $set: 'OtherSuggestions' },
                })

                extractedData = results.filter((result) => {
                    return (
                        result.creatorId !==
                        previousState.currentUserReference.id
                    )
                })

                extractedData = extractedData.map((result) => {
                    return {
                        pageTitle: result.pageTitle,
                        contentText: result.contentText,
                    }
                })
            }

            textToAnalyse = JSON.stringify(extractedData)
            isContentSearch = true

            await this.updateSuggestionResults(results)
        }

        const response = await this.options.summarizeBG.startPageSummaryStream({
            fullPageUrl:
                isPagePDF || previousState.fetchLocalHTML
                    ? undefined
                    : fullPageUrl && fullPageUrl
                    ? fullPageUrl
                    : undefined,
            textToProcess: textToAnalyse,
            queryPrompt: queryPrompt,
            apiKey: openAIKey ? openAIKey : undefined,
            outputLocation: outputLocation ?? null,
            chapterSummaryIndex: chapterSummaryIndex ?? null,
            AImodel: previousState.AImodel,
            isContentSearch: isContentSearch ? true : false,
        })

        return response
    }

    async executeAIquery() {}

    removeAISuggestion: EventHandler<'removeAISuggestion'> = async ({
        event,
        previousState,
    }) => {
        let suggestions = this.AIpromptSuggestions

        const suggestionToRemove = event.suggestion
        const newSuggestions = suggestions.filter(
            (item) => item.prompt !== suggestionToRemove,
        )

        const newSuggestionsToSave = newSuggestions.map((item) => item.prompt)

        await this.syncSettings.openAI.set(
            'promptSuggestions',
            newSuggestionsToSave,
        )

        this.emitMutation({
            AIsuggestions: { $set: newSuggestions },
        })

        this.AIpromptSuggestions = newSuggestions
    }

    saveAIPrompt: EventHandler<'saveAIPrompt'> = async ({
        event,
        previousState,
    }) => {
        this.emitMutation({
            showAISuggestionsDropDown: { $set: true },
        })
        let suggestions = this.AIpromptSuggestions

        let newSuggestion = { prompt: event.prompt, focused: null }

        suggestions.unshift(newSuggestion)

        const newSuggestionsToSave = suggestions.map((item) => item.prompt)

        await this.syncSettings.openAI.set(
            'promptSuggestions',
            newSuggestionsToSave,
        )

        this._updateFocusAISuggestions(-1, suggestions)

        this.AIpromptSuggestions = suggestions
    }

    toggleAISuggestionsDropDown: EventHandler<
        'toggleAISuggestionsDropDown'
    > = async ({ event, previousState }) => {
        if (previousState.showAISuggestionsDropDown) {
            this._updateFocusAISuggestions(-1, previousState.AIsuggestions)
            this.emitMutation({
                showAISuggestionsDropDown: {
                    $set: false,
                },
            })
            return
        }

        const rawSuggestions = await this.syncSettings.openAI.get(
            'promptSuggestions',
        )

        let suggestions = []

        if (!rawSuggestions) {
            await this.syncSettings.openAI.set(
                'promptSuggestions',
                AI_PROMPT_DEFAULTS,
            )

            suggestions = AI_PROMPT_DEFAULTS.map((prompt: string) => {
                return { prompt, focused: null }
            })
        } else {
            suggestions = rawSuggestions.map((prompt: string) => ({
                prompt,
                focused: null,
            }))
        }

        this.emitMutation({
            showAISuggestionsDropDown: {
                $set: !previousState.showAISuggestionsDropDown,
            },
        })

        if (!previousState.showAISuggestionsDropDown) {
            this.emitMutation({
                AIsuggestions: { $set: suggestions },
            })
        }
        this.AIpromptSuggestions = suggestions
    }

    private _updateFocusAISuggestions = (
        focusIndex: number | undefined,
        displayEntries?: { prompt: string; focused: boolean }[],
        emit = true,
    ) => {
        this.focusIndex = focusIndex ?? -1
        if (!displayEntries) {
            return
        }

        for (let i = 0; i < displayEntries.length; i++) {
            displayEntries[i].focused = focusIndex === i
        }

        let suggestions = displayEntries

        this.emitMutation({
            AIsuggestions: { $set: suggestions },
        })

        if (focusIndex >= 0) {
            this.emitMutation({
                prompt: { $set: suggestions[focusIndex].prompt },
            })
        }
    }

    selectAISuggestion: EventHandler<'selectAISuggestion'> = async ({
        event,
        previousState,
    }) => {
        this.emitMutation({
            showAISuggestionsDropDown: { $set: false },
        })

        const prompt = event.suggestion

        await this.processUIEvent('queryAIwithPrompt', {
            event: { prompt: prompt },
            previousState,
        })
    }
    navigateFocusInList: EventHandler<'navigateFocusInList'> = async ({
        event,
        previousState,
    }) => {
        const displayEntries = previousState.AIsuggestions

        if (!displayEntries) {
            return
        }

        let focusIndex

        if (this.focusIndex == null) {
            focusIndex = -1
        } else {
            focusIndex = this.focusIndex
        }

        if (event.direction === 'up') {
            if (focusIndex > 0) {
                this._updateFocusAISuggestions(focusIndex - 1, displayEntries)
            }
        }

        if (event.direction === 'down') {
            if (focusIndex < displayEntries.length - 1) {
                this._updateFocusAISuggestions(focusIndex + 1, displayEntries)
            }
        }
    }

    queryAIwithPrompt: EventHandler<'queryAIwithPrompt'> = async ({
        event,
        previousState,
    }) => {
        if (event.prompt == null) {
            this.emitMutation({
                showAISuggestionsDropDown: {
                    $set: false,
                },
                showChapters: { $set: false },
                loadState: { $set: 'success' },
            })
            return
        }

        if (previousState.queryMode === 'chapterSummary') {
            this.emitMutation({
                prompt: { $set: event.prompt },
                showAISuggestionsDropDown: {
                    $set: false,
                },
                showChapters: { $set: true },
            })
            return
        }

        this.emitMutation({
            prompt: { $set: event.prompt },
            showAISuggestionsDropDown: {
                $set: false,
            },
            showChapters: { $set: false },
            loadState: { $set: 'running' },
        })

        if (event.prompt.length === 0) {
            this.emitMutation({
                loadState: { $set: 'success' },
            })
            return
        }

        if (event.prompt?.length > 0 || previousState.prompt?.length > 0) {
            let isPagePDF = window.location.href.includes('/pdfjs/viewer.html?')
            let fullTextToProcess
            if (isPagePDF) {
                const searchParams = new URLSearchParams(window.location.search)
                const filePath = searchParams.get('file')
                const pdf: PDFDocumentProxy = await (globalThis as any)[
                    'pdfjsLib'
                ].getDocument(filePath).promise
                const text = await extractDataFromPDFDocument(pdf, true)
                fullTextToProcess = document.body.innerText
            }

            this.emitMutation({
                loadState: { $set: 'running' },
            })

            if (
                event.queryMode === 'question' ||
                previousState.queryMode === 'question'
            ) {
                this.queryAI(
                    undefined,
                    null,
                    event.prompt ? event.prompt : previousState.prompt,
                    previousState,
                    undefined,
                )
            } else if (
                event.queryMode === 'summarize' ||
                previousState.queryMode === 'summarize'
            ) {
                this.queryAI(
                    isPagePDF ? undefined : previousState.fullPageUrl,
                    event.highlightedText ||
                        previousState.selectedTextAIPreview,
                    event.prompt ? event.prompt : previousState.prompt,
                    previousState,
                    isPagePDF ? fullTextToProcess : undefined,
                )
            }
        }
    }

    setQueryMode: EventHandler<'setQueryMode'> = async ({ event }) => {
        this.emitMutation({
            queryMode: { $set: event.mode },
        })
    }

    updatePromptState: EventHandler<'updatePromptState'> = async ({
        event,
        previousState,
    }) => {
        const pattern = new RegExp(event.prompt, 'i')
        const newSuggestions = this.AIpromptSuggestions?.filter((item) =>
            pattern.test(item.prompt),
        )
        if (event.prompt?.length === 0) {
            this._updateFocusAISuggestions(-1, newSuggestions)
        } else {
            if (newSuggestions?.length > 0) {
                this.emitMutation({
                    showAISuggestionsDropDown: { $set: true },
                })
            }
        }

        this.emitMutation({
            prompt: { $set: event.prompt },
            AIsuggestions: { $set: newSuggestions },
        })
    }

    removeSelectedTextAIPreview: EventHandler<
        'removeSelectedTextAIPreview'
    > = async () => {
        this.emitMutation({
            selectedTextAIPreview: { $set: undefined },
        })
    }

    askAIviaInPageInteractions: EventHandler<
        'askAIviaInPageInteractions'
    > = async ({ event, previousState }) => {
        this.emitMutation({ activeTab: { $set: 'summary' } })

        let prompt =
            event.prompt?.length > 0
                ? event.prompt
                : 'Tell me the key takeaways: '
        let highlightedText =
            event.textToProcess?.length > 0 ? event.textToProcess : null

        await this.processUIEvent('queryAIwithPrompt', {
            event: {
                prompt: prompt,
                highlightedText: event.textToProcess,
                queryMode: 'summarize',
            },
            previousState,
        })

        this.emitMutation({
            pageSummary: { $set: '' },
            selectedTextAIPreview: { $set: event.textToProcess },
            prompt: {
                $set: prompt,
            },
        })
    }

    private handleMouseUpToTriggerRabbitHole = (event) => {
        this.listenToTextHighlightSuggestions()
    }

    setActiveSuggestionsTab: EventHandler<'setActiveSuggestionsTab'> = async ({
        event,
        previousState,
    }) => {
        this.emitMutation({
            activeSuggestionsTab: { $set: event.tab },
        })
    }
    setSummaryMode: EventHandler<'setSummaryMode'> = async ({
        event,
        previousState,
    }) => {
        this.emitMutation({
            summaryModeActiveTab: { $set: event.tab },
        })
    }
    setExistingSourcesOptions: EventHandler<
        'setExistingSourcesOptions'
    > = async ({ event, previousState }) => {
        this.emitMutation({
            existingSourcesOption: { $set: event },
        })
    }
    setFeedSourcesMenu: EventHandler<'setFeedSourcesMenu'> = async ({
        event,
        previousState,
    }) => {
        if (previousState.showFeedSourcesMenu) {
            this.emitMutation({
                existingSourcesOption: { $set: 'pristine' },
            })
        }

        this.emitMutation({
            showFeedSourcesMenu: { $set: !previousState.showFeedSourcesMenu },
        })
    }
    setActiveAITab: EventHandler<'setActiveAITab'> = async ({
        event,
        previousState,
    }) => {
        if (event.tab !== 'ThisPage') {
            await this.checkRabbitHoleOnboardingStage()
            this.emitMutation({
                selectedTextAIPreview: { $set: null },
            })
        }
        this.emitMutation({
            activeAITab: { $set: event.tab },
        })
    }

    setActiveSidebarTab: EventHandler<'setActiveSidebarTab'> = async ({
        event,
        previousState,
    }) => {
        document.removeEventListener(
            'mouseup',
            this.handleMouseUpToTriggerRabbitHole,
        )

        this.emitMutation({
            activeTab: { $set: event.tab },
            showFeedSourcesMenu: { $set: false },
            existingSourcesOption: { $set: 'pristine' },
        })

        // Ensure in-page selectedList state only applies when the spaces tab is active
        const returningToSelectedListMode =
            previousState.selectedListId != null && event.tab === 'spaces'
        this.options.events?.emit(
            'setSelectedList',
            returningToSelectedListMode ? previousState.selectedListId : null,
        )

        if (event.tab === 'annotations') {
            this.renderOwnHighlights(previousState)
        } else if (returningToSelectedListMode) {
            this.options.events?.emit('renderHighlights', {
                highlights: cacheUtils.getListHighlightsArray(
                    this.options.annotationsCache,
                    previousState.selectedListId,
                ),
                removeExisting: true,
            })
        } else if (event.tab === 'spaces') {
            await this.loadRemoteAnnototationReferencesForCachedLists(
                previousState,
            )
            this.renderOwnHighlights(previousState)
        } else if (
            event.tab === 'summary' &&
            ((event.prompt && event.prompt?.length > 0) ||
                event.textToProcess?.length > 0)
        ) {
            if (previousState.pageSummary?.length === 0) {
                let isPagePDF = window.location.href.includes(
                    '/pdfjs/viewer.html?',
                )
                let fullTextToProcess
                if (isPagePDF) {
                    fullTextToProcess = document.body.innerText
                }
                if (event.textToProcess) {
                    this.emitMutation({
                        prompt: { $set: '' },
                        loadState: { $set: 'running' },
                    })
                    await this.queryAI(
                        undefined,
                        event.textToProcess,
                        undefined,
                        previousState,
                    )
                } else {
                    this.emitMutation({
                        prompt: { $set: event.prompt },
                        loadState: { $set: 'running' },
                    })
                    await this.queryAI(
                        isPagePDF ? undefined : previousState.fullPageUrl,
                        undefined,
                        undefined,
                        previousState,
                        isPagePDF ? fullTextToProcess : undefined,
                    )
                }
            }
        } else if (event.tab === 'rabbitHole') {
            this.emitMutation({
                suggestionsResultsLoadState: { $set: 'running' },
            })
            this.previousState = previousState
            if (
                !(
                    previousState.rabbitHoleBetaFeatureAccess === 'onboarded' ||
                    (await this.checkRabbitHoleOnboardingStage()) ===
                        'onboarded'
                )
            ) {
                this.emitMutation({
                    suggestionsResultsLoadState: { $set: 'success' },
                })
                return
            }

            const currentPageContent =
                document.title && document.title + document.body.innerText

            const prompt = `You are given the text of a web page. Your task is to summarise it in such a way that is ideally suited for similarity comparison with other texts. This means you should retain all key entities and concepts as much as you can. Here is the text of the page:  `

            // const summary = await this.options.summarizeBG.getTextSummary({
            //     text: currentPageContent,
            //     prompt: prompt,
            // })

            // const summarisedText = summary.choices[0].text

            // add step to summmarise page and extract key information suitable for similiarity search

            let results
            results = await this.options.customListsBG.findSimilarBackground(
                currentPageContent,
                normalizeUrl(previousState.fullPageUrl, {
                    skipProtocolTrim: true,
                }),
            )

            if (results.length === 0) {
                this.emitMutation({
                    suggestionsResultsLoadState: { $set: 'success' },
                })
            }
            if (results === 'not-connected' || results === 'not-allowed') {
                this.emitMutation({
                    suggestionsResultsLoadState: { $set: 'error' },
                })
                return
            }

            results = results.reduce(
                (acc: SuggestionCard[], curr: SuggestionCard) => {
                    const existing = acc.find(
                        (item) => item.fullUrl === curr.fullUrl,
                    )
                    if (!existing) {
                        return acc.concat([curr])
                    } else if (existing.distance > curr.distance) {
                        return acc
                            .filter((item) => item.fullUrl !== curr.fullUrl)
                            .concat([curr])
                    } else {
                        return acc
                    }
                },
                [],
            )

            await this.updateSuggestionResults(results)

            // Add the event listener
            document.addEventListener(
                'mouseup',
                this.handleMouseUpToTriggerRabbitHole,
            )
        }
    }

    async listenToTextHighlightSuggestions() {
        const selectedText = window.getSelection().toString().trim()
        if (selectedText?.length > 0) {
            this.emitMutation({
                suggestionsResultsLoadState: { $set: 'running' },
            })
            let results = await this.options.customListsBG.findSimilarBackground(
                selectedText,
                normalizeUrl(this.previousState.fullPageUrl, {
                    skipProtocolTrim: true,
                }),
            )

            results = results.reduce(
                (acc: SuggestionCard[], curr: SuggestionCard) => {
                    const existing = acc.find(
                        (item) => item.fullUrl === curr.fullUrl,
                    )
                    if (!existing) {
                        return acc.concat([curr])
                    } else if (existing.distance > curr.distance) {
                        return acc
                            .filter((item) => item.fullUrl !== curr.fullUrl)
                            .concat([curr])
                    } else {
                        return acc
                    }
                },
                [],
            )
            await this.updateSuggestionResults(results)
        }
    }

    openLocalFile: EventHandler<'openLocalFile'> = async ({ event }) => {
        await this.options.pkmSyncBG.openLocalFile(event.path)
    }
    addLocalFolder: EventHandler<'addLocalFolder'> = async ({
        previousState,
    }) => {
        const folder = await this.options.pkmSyncBG.addLocalFolder()

        let localFolders = previousState.localFoldersList
        localFolders.unshift(folder)

        this.emitMutation({
            localFoldersList: { $set: localFolders },
        })
    }
    removeLocalFolder: EventHandler<'removeLocalFolder'> = async ({
        previousState,
        event,
    }) => {
        let folderId = event.id
        let localFolders = previousState.localFoldersList

        // Find the index of the folder with the id = event.id
        const folderIndex = localFolders.findIndex(
            (folder) => folder.id === folderId,
        )

        // If the folder is found, remove it from the array
        if (folderIndex !== -1) {
            localFolders.splice(folderIndex, 1)
        }

        this.emitMutation({
            localFoldersList: { $set: localFolders },
        })

        await this.options.pkmSyncBG.removeLocalFolder(folderId)
    }
    getLocalFolders: EventHandler<'getLocalFolders'> = async ({}) => {
        const localFolders = await this.options.pkmSyncBG.getLocalFolders()

        this.emitMutation({
            localFoldersList: { $set: localFolders },
        })
    }

    async updateSuggestionResults(results: SuggestionCard[]) {
        const resultsArray: SuggestionCard[] = []
        const user = await this.options.authBG.getCurrentUser()
        const userId = user?.id

        type spaceItem = {
            name: string
            id?: number
            unifiedId?: string
            isShared?: boolean
            remoteId?: string | AutoPk
            localId?: number | null
        }

        // Filter the resultsArray to only have one item from the same URL, and take the one with the lowest "distance" value

        if (results) {
            for (let result of Object.values(results)) {
                let space: spaceItem
                let pageData
                let pageToDisplay: SuggestionCard

                if (
                    userId != result.creatorId &&
                    result.contentType === 'page'
                ) {
                    const followedPageListData = []
                    const spacesData = await this.options.pageActivityIndicatorBG.getPageFollowedLists(
                        result.fullUrl,
                    )

                    for (let spaceItemKey in spacesData) {
                        let spaceItem = spacesData[spaceItemKey]
                        space = {
                            name: spaceItem.name,
                            remoteId: spaceItem.sharedList,
                            unifiedId: null,
                            isShared: false,
                            localId: null,
                            id: null,
                        }
                        followedPageListData.push(space)
                    }

                    pageToDisplay = {
                        fullUrl: result.fullUrl,
                        pageTitle: result.pageTitle,
                        contentText: result.contentText,
                        contentType: result.contentType,
                        creatorId: result.creatorId,
                        spaces: followedPageListData,
                        sourceApplication: result.sourceApplication,
                    }
                } else {
                    if (
                        result.contentType === 'page' ||
                        result.contentType === 'rss-feed-item'
                    ) {
                        const pageListData = []
                        pageData = await this.options.customListsBG.findPageByUrl(
                            normalizeUrl(result.fullUrl),
                        )

                        if (pageData) {
                            const pageLists = await this.options.customListsBG.fetchPageLists(
                                { url: pageData?.fullUrl },
                            )

                            if (pageLists.length > 0) {
                                for (let pageList of pageLists) {
                                    const list = await this.options.annotationsCache.getListByLocalId(
                                        pageList,
                                    )
                                    space = {
                                        name: list.name,
                                        remoteId: list.remoteId,
                                        unifiedId: list.unifiedId,
                                        isShared: !list.isPrivate,
                                        localId: list.localId,
                                        id: list.localId,
                                    }
                                    pageListData.push(space)
                                }
                            }
                        }

                        pageToDisplay = {
                            fullUrl: pageData?.fullUrl || result?.fullUrl,
                            pageTitle: pageData?.fullTitle || result?.pageTitle,
                            contentText: result.contentText,
                            contentType: result.contentType,
                            creatorId: userId,
                            spaces: pageListData ?? null,
                        }
                    } else if (result.contentType === 'pdf') {
                        const pageListData = []

                        pageData = await this.options.customListsBG.findPageByUrl(
                            normalizeUrl(result.fullUrl),
                        )

                        if (pageData) {
                            pageToDisplay = {
                                fullUrl: result.path,
                                pageTitle: pageData?.fullTitle,
                                contentText: result.contentText,
                                contentType: result.contentType,
                                creatorId: userId,
                                spaces: pageListData ?? null,
                            }
                        } else {
                            pageToDisplay = {
                                fullUrl: result.path,
                                pageTitle: result?.pageTitle,
                                contentText: result.contentText,
                                contentType: result.contentType,
                                creatorId: userId,
                                spaces: pageListData ?? null,
                            }
                        }
                    } else if (result.contentType === 'markdown') {
                        const sourceApplication = result.sourceApplication

                        let url = ''
                        let file = result.path?.split(
                            `${result.topLevelFolder}/`,
                        )[1]
                        if (sourceApplication === 'obsidian') {
                            url =
                                `obsidian://open?vault=${result.topLevelFolder}&file=` +
                                encodeURIComponent(file)
                        }
                        if (sourceApplication === 'logseq') {
                            url = `logseq://graph/${result.topLevelFolder}?page=${result.pageTitle}`
                        }
                        if (sourceApplication === 'local') {
                            url = result.path
                        }

                        pageToDisplay = {
                            fullUrl: url,
                            pageTitle: result?.pageTitle,
                            contentText: result.contentText,
                            contentType: result.contentType,
                            sourceApplication: sourceApplication,
                            creatorId: userId,
                            spaces: null,
                        }
                    } else if (result.contentType === 'annotation') {
                        try {
                            const annotationUrl = normalizeUrl(
                                result.fullUrl,
                            )?.split('/#')[0]

                            const normalizedUrl = normalizeUrl(result.fullUrl, {
                                stripHash: false,
                            })

                            let annotationRawData = await this.options.annotationsBG.getAnnotationByPk(
                                {
                                    url: result.fullUrl.replace('https://', ''),
                                },
                            )

                            // Convert the string to a Date object
                            let createdWhenDate = new Date(
                                annotationRawData.createdWhen,
                            )

                            // Now you can use getTime method
                            annotationRawData.createdWhen = Math.floor(
                                createdWhenDate.getTime(),
                            )
                            let lastEditedDate = new Date(
                                annotationRawData.lastEdited,
                            )

                            // Now you can use getTime method
                            annotationRawData.lastEdited = Math.floor(
                                lastEditedDate.getTime(),
                            )
                            annotationRawData.lists = []

                            const annotationForCache = cacheUtils.reshapeAnnotationForCache(
                                annotationRawData,
                                annotationRawData.createdWhen,
                            )
                            const annotationsCacheVersion = await this.options.annotationsCache.addAnnotation(
                                annotationForCache,
                            )

                            if (annotationsCacheVersion) {
                                pageToDisplay = {
                                    fullUrl: annotationUrl,
                                    pageTitle:
                                        result.pageTitle ?? annotationUrl,
                                    body: annotationRawData?.body ?? null,
                                    comment: annotationRawData?.comment ?? null,
                                    contentType: result.contentType,
                                    creatorId: result.creatorId,
                                    unifiedId:
                                        annotationsCacheVersion.unifiedId,
                                }
                            }
                        } catch (e) {
                            console.log('Error', e)
                        }
                    }
                }
                if (pageToDisplay) {
                    resultsArray.push(pageToDisplay)
                }
            }
        }

        // next step is to fetch the respective user data from the creators, potentially load them async after reuslts already display

        this.emitMutation({
            suggestionsResults: { $set: resultsArray ?? [] },
            suggestionsResultsLoadState: { $set: 'success' },
        })

        return resultsArray
    }

    private async maybeLoadListRemoteAnnotations(
        state: SidebarContainerState,
        unifiedListId: UnifiedList['unifiedId'],
    ): Promise<SidebarContainerState> {
        const { annotationsCache, annotationsBG } = this.options
        const list = state.lists.byId[unifiedListId]
        const listInstance = state.listInstances[unifiedListId]
        let nextState = state

        if (
            !list ||
            !listInstance ||
            list.remoteId == null ||
            listInstance.annotationsLoadState !== 'pristine' // Means already loaded previously
        ) {
            return nextState
        }

        let sharedAnnotationReferences: SharedAnnotationReference[]

        // This first clause covers the case of setting up conversations states for own shared lists, without entries from others
        if (
            !list.hasRemoteAnnotationsToLoad ||
            listInstance.sharedAnnotationReferences == null
        ) {
            const sharedAnnotationUnifiedIds = list.unifiedAnnotationIds.filter(
                (unifiedId) =>
                    annotationsCache.annotations.byId[unifiedId]?.remoteId !=
                    null,
            )

            sharedAnnotationReferences = sharedAnnotationUnifiedIds.map(
                (unifiedId) => ({
                    type: 'shared-annotation-reference',
                    id: annotationsCache.annotations.byId[unifiedId].remoteId,
                }),
            )

            nextState = this.applyAndEmitMutation(nextState, {
                conversations: {
                    $merge: fromPairs(
                        sharedAnnotationUnifiedIds.map((unifiedId) => [
                            generateAnnotationCardInstanceId(
                                { unifiedId },
                                list.unifiedId,
                            ),
                            getInitialAnnotationConversationState(),
                        ]),
                    ),
                },
            })
        } else {
            // This clause covers the other cases of setting up convo states for followed and joined lists
            sharedAnnotationReferences = listInstance.sharedAnnotationReferences

            await executeUITask(
                this,
                (taskState) => ({
                    listInstances: {
                        [unifiedListId]: {
                            annotationsLoadState: { $set: taskState },
                        },
                    },
                }),
                async () => {
                    const sharedAnnotations = await annotationsBG.getSharedAnnotations(
                        {
                            sharedAnnotationReferences:
                                listInstance.sharedAnnotationReferences,
                            withCreatorData: true,
                        },
                    )

                    const usersData: SidebarContainerState['users'] = {}
                    for (const annot of sharedAnnotations) {
                        if (annot.creator?.user.displayName != null) {
                            usersData[annot.creatorReference.id] = {
                                name: annot.creator.user.displayName,
                                profileImgSrc: annot.creator.profile?.avatarURL,
                            }
                        }

                        annotationsCache.addAnnotation(
                            cacheUtils.reshapeSharedAnnotationForCache(annot, {
                                extraData: { unifiedListIds: [unifiedListId] },
                            }),
                        )
                    }

                    this.options.events?.emit('renderHighlights', {
                        highlights: cacheUtils.getListHighlightsArray(
                            this.options.annotationsCache,
                            unifiedListId,
                        ),
                        removeExisting: false,
                    })

                    // Ensure cache added annotations are set in latest state
                    nextState = {
                        ...nextState,
                        annotations: annotationsCache.annotations,
                    }

                    nextState = this.applyAndEmitMutation(nextState, {
                        users: { $merge: usersData },
                        conversations: {
                            $merge: getInitialAnnotationConversationStates(
                                listInstance.sharedAnnotationReferences.map(
                                    ({ id }) => ({
                                        linkId: id.toString(),
                                    }),
                                ),
                                (remoteAnnotId) =>
                                    this.buildConversationId(remoteAnnotId, {
                                        type: 'shared-list-reference',
                                        id: list.remoteId,
                                    }),
                            ),
                        },
                    })
                },
            )
        }

        await this.detectConversationThreads(
            unifiedListId,
            list.remoteId,
            sharedAnnotationReferences,
        )
        return nextState
    }

    async detectConversationThreads(
        unifiedListId: string,
        remoteListId: string,
        sharedAnnotationReferences: SharedAnnotationReference[],
    ) {
        await executeUITask(
            this,
            (taskState) => ({
                listInstances: {
                    [unifiedListId]: {
                        conversationsLoadState: { $set: taskState },
                    },
                },
            }),
            async () => {
                await detectAnnotationConversationThreads(this as any, {
                    buildConversationId: this.buildConversationId,
                    annotationReferences: sharedAnnotationReferences,
                    sharedListReference: {
                        type: 'shared-list-reference',
                        id: remoteListId,
                    },
                    getThreadsForAnnotations: ({
                        annotationReferences,
                        sharedListReference,
                    }) =>
                        this.options.contentConversationsBG.getThreadsForSharedAnnotations(
                            {
                                sharedAnnotationReferences: annotationReferences,
                                sharedListReference,
                            },
                        ),
                    imageSupport: this.options.imageSupport,
                })
            },
        )
    }

    expandListAnnotations: EventHandler<'expandListAnnotations'> = async ({
        event,
        previousState,
    }) => {
        const listInstanceMutation: UIMutation<SidebarContainerState> = {
            listInstances: {
                [event.unifiedListId]: {
                    isOpen: { $apply: (isOpen) => !isOpen },
                },
            },
        }
        const nextState = this.withMutation(previousState, listInstanceMutation)
        this.emitMutation(listInstanceMutation)

        // NOTE: It's important the annots+lists states are gotten from the cache here as the above async call
        //   can result in new annotations being added to the cache which won't yet update this logic class' state
        //   (though they cache's state will be up-to-date)
        this.renderOpenSpaceInstanceHighlights({
            annotations: this.options.annotationsCache.annotations,
            lists: this.options.annotationsCache.lists,
            listInstances: nextState.listInstances,
        })
        await this.maybeLoadListRemoteAnnotations(
            previousState,
            event.unifiedListId,
        )
    }

    setSpaceTitleEditValue: EventHandler<'setSpaceTitleEditValue'> = ({
        event,
    }) => {
        this.emitMutation({
            spaceTitleEditValue: { $set: event.value },
        })
    }
    addedKey: EventHandler<'addedKey'> = ({ event, previousState }) => {
        this.emitMutation({
            hasKey: {
                $set: previousState.hasKey ? !previousState.hasKey : true,
            },
        })
    }

    markFeedAsRead: EventHandler<'markFeedAsRead'> = async () => {
        // const activityindicator = await this.options.activityIndicatorBG.markActivitiesAsSeen()
        // await setLocalStorage(ACTIVITY_INDICATOR_ACTIVE_CACHE_KEY, false)

        this.emitMutation({
            hasFeedActivity: { $set: false },
        })
    }

    private async setLocallyAvailableSelectedList(
        state: SidebarContainerState,
        unifiedListId: UnifiedList['unifiedId'],
    ): Promise<SidebarContainerState> {
        this.options.events?.emit('setSelectedList', unifiedListId)

        const list = state.lists.byId[unifiedListId]
        const listInstance = state.listInstances[unifiedListId]
        if (!list || !listInstance) {
            console.warn(
                'setSelectedList: could not find matching list for cache ID:',
                unifiedListId,
            )
            return state
        }

        const listTitle = list.name

        let nextState = this.applyAndEmitMutation(state, {
            activeTab: { $set: 'spaces' },
            selectedListId: { $set: unifiedListId },
            spaceTitleEditValue: { $set: listTitle },
        })

        this.options.events?.emit('renderHighlights', {
            highlights: cacheUtils.getListHighlightsArray(
                this.options.annotationsCache,
                unifiedListId,
            ),
            removeExisting: true,
        })

        if (list.remoteId != null) {
            nextState = await this.loadRemoteAnnotationReferencesForSpecificLists(
                nextState,
                [list],
            )
            nextState = await this.maybeLoadListRemoteAnnotations(
                nextState,
                unifiedListId,
            )
        }
        return nextState
    }

    createYoutubeTimestampWithScreenshot: EventHandler<
        'createYoutubeTimestampWithScreenshot'
    > = async ({ previousState, event }) => {
        this.emitMutation({
            loadState: { $set: 'success' },
            activeTab: { $set: 'annotations' },
        })
        this.options.focusCreateForm()

        const maxRetries = 50
        let handledSuccessfully = false

        for (let i = 0; i < maxRetries; i++) {
            if (
                this.options.events.emit(
                    'addImageToEditor',
                    {
                        imageData: event.imageData,
                    },
                    (success) => {
                        handledSuccessfully = success
                    },
                )
            ) {
                break
            }
            await sleepPromise(50) // wait for half a second before trying again
        }
    }

    getVideoChapters: EventHandler<'getVideoChapters'> = async ({
        previousState,
    }) => {
        this.emitMutation({
            loadState: { $set: 'running' },
            queryMode: { $set: 'chapterSummary' },
        })
        let videoDetails = null
        if (previousState.videoDetails == null) {
            videoDetails = JSON.parse(
                await this.getYoutubeDetails(window.location.href),
            )
            if (videoDetails.details.chapters.length === 0) {
                this.emitMutation({
                    loadState: { $set: 'success' },
                    showChapters: { $set: true },
                    videoDetails: { $set: null },
                })
                return
            } else {
                this.emitMutation({
                    videoDetails: { $set: videoDetails },
                })
            }
        } else {
            videoDetails = previousState.videoDetails
        }

        const chapters = videoDetails.details.chapters

        let chapterListClean = []
        chapters.map((chapter) => {
            const chapterStart = chapter.startingMs / 1000
            const chapterTitle = chapter.title

            const timestampElementsReadable = this.secondsToHMS(chapterStart)

            const videoURLWithTime = constructVideoURLwithTimeStamp(
                window.location.href,
                chapterStart,
            )

            chapterListClean.push({
                start: chapterStart,
                humanReadableTimestamp: timestampElementsReadable,
                linktoSection: videoURLWithTime,
                title: chapterTitle,
            })
        })

        this.emitMutation({
            chapterList: { $set: chapterListClean },
            showChapters: { $set: true },
            loadState: { $set: 'success' },
        })
    }

    summariseChapter: EventHandler<'summariseChapter'> = async ({
        previousState,
        event,
    }) => {
        let chapterSummaries =
            previousState.chapterSummaries ??
            previousState.chapterList.map((item, i) => {
                return null
            })

        chapterSummaries[event.chapterIndex] = {
            chapterIndex: event.chapterIndex,
            summary: '',
            loadingState: 'running',
        }

        this.chapterSummaries = chapterSummaries

        this.emitMutation({
            chapterSummaries: {
                $set: chapterSummaries,
            },
        })
        let transcript = null
        if (previousState.youtubeTranscriptJSON == null) {
            transcript = await this.getYoutubeTranscript(window.location.href)
            this.emitMutation({
                youtubeTranscriptJSON: { $set: transcript },
            })
        } else {
            transcript = previousState.youtubeTranscriptJSON
        }

        let transcriptChunkedByChapter = []
        let chapters = previousState.chapterList
        let videoLength = previousState.videoDetails
            ? /* @ts-ignore */
              previousState.videoDetails?.details?.lengthSeconds
            : null

        if (chapters) {
            let currentChapterStart = chapters[event.chapterIndex]?.start
            let nextChapterStart
            if (event.chapterIndex === chapters.length - 1) {
                nextChapterStart = videoLength
            } else {
                nextChapterStart =
                    chapters[event.chapterIndex + 1].start ?? videoLength - 1
            }
            let chapterTranscript = transcript.filter(
                (item) =>
                    item.start >= currentChapterStart - 2 &&
                    item.start < nextChapterStart,
            )
            transcriptChunkedByChapter.push(chapterTranscript)
        }

        const chapterToSummarise = transcriptChunkedByChapter[0]

        const textToSummarise = this.chapterGroupPrepare(chapterToSummarise)

        let userPrompt =
            previousState.prompt ?? 'Summarise this concisely and briefly'

        let prompt = `You are given the content of a in a YouTube video. Provide a concise summary and do not introduce the summary by referring to it as "video sections", "text", "transcript", or "content". Ensure your answer is complete sentences. Please apply the prompt "${userPrompt}". Here is the excerpt for your review:`

        await this.queryAI(
            undefined,
            textToSummarise,
            userPrompt,
            previousState,
            null,
            'chapterSummary',
            event.chapterIndex,
        )
    }

    chapterGroupPrepare(jsonArray: Object[]) {
        const text = jsonArray
            .map((item: any) => item.text)
            .join(' ')
            .replace(/<[^>]+>/g, '') // Remove HTML tags
            .replace(/&#39;/g, "'") // Replace &#39; with an apostrophe
            .replace(/\n/g, ' ') // Remove new lines
            .trim()

        return text
    }

    secondsToHMS(seconds: number) {
        const hrs = Math.floor(seconds / 3600)
        const mins = Math.floor((seconds % 3600) / 60)
        const secs = Math.floor(seconds % 60)

        const formattedHrs = hrs > 0 ? String(hrs).padStart(2, '0') + ':' : ''
        const formattedMins =
            mins > 0 || hrs > 0 ? String(mins).padStart(2, '0') + ':' : '00:'
        const formattedSecs = String(secs).padStart(2, '0')

        return formattedHrs + formattedMins + formattedSecs
    }

    createYoutubeTimestampWithAISummary: EventHandler<
        'createYoutubeTimestampWithAISummary'
    > = async ({ previousState, event }) => {
        let transcript = null
        if (previousState.youtubeTranscriptJSON == null) {
            transcript = await this.getYoutubeTranscript(window.location.href)
            this.emitMutation({
                youtubeTranscriptJSON: { $set: transcript },
            })
        } else {
            transcript = previousState.youtubeTranscriptJSON
        }

        const filteredTranscript = await this.getTranscriptSection(
            transcript,
            event.videoRangeTimestamps.startTimeSecs,
            event.videoRangeTimestamps.endTimeSecs,
        )
        this.emitMutation({
            loadState: { $set: 'success' },
            activeTab: { $set: 'annotations' },
        })
        this.options.focusCreateForm()
        this.emitMutation({
            commentBox: {
                commentText: { $set: '' },
            },
            pageSummary: { $set: '' },
            prompt: { $set: null },
        })
        // is here bc for some reason else the timestamps will not be pushed, seems like a race condition

        await sleepPromise(0)

        const maxRetries = 30
        let handledSuccessfully = false

        const humanTimestamp = `${Math.floor(
            event.videoRangeTimestamps.startTimeSecs / 60,
        )}:${(event.videoRangeTimestamps.startTimeSecs % 60)
            .toString()
            .padStart(2, '0')}`

        const videoURLWithTime = constructVideoURLwithTimeStamp(
            window.location.href,
            event.videoRangeTimestamps.startTimeSecs,
        )

        for (let i = 0; i < maxRetries; i++) {
            if (
                this.options.events.emit(
                    'triggerYoutubeTimestampSummary',
                    {
                        text: `[${humanTimestamp}](${videoURLWithTime}) `,
                        showLoadingSpinner: true,
                    },
                    (success) => {
                        handledSuccessfully = success
                    },
                )
            ) {
                break
            }
            await sleepPromise(50) // wait for half a second before trying again
        }

        const combinedText = filteredTranscript
            .map((item) => item.text)
            .join(' ')

        let prompt =
            'You are given a text snippet that is from a transcript of a section of a video. Summarize it by talking abstractly about its content and aim for brevity in your summary. The primary purpose of your summary is to help users identify video sections and their content. Do not refer to it as "video sections" or "text" or "transcript", just talk about the content abstractly. Also do not include the prompt in the summary. The transcript may contain errors; kindly correct them while retaining the original intent. Avoid using list formats. Here is the excerpt for your review:'

        await this.queryAI(
            undefined,
            combinedText,
            prompt,
            previousState,
            null,
            'editor',
        )

        this.emitMutation({
            pageSummary: { $set: '' },
            prompt: { $set: null },
            selectedTextAIPreview: {
                $set: '',
            },
        })
    }

    setSelectedList: EventHandler<'setSelectedList'> = async ({
        event,
        previousState,
    }) => {
        // TODO : this is a hack to stop users clicking on space pills before the followed lists have been loaded
        //  Because shit breaks down if they're not loaded and everything's too much of a mess to untangle right now.
        //  Should become much less of a problem once we load followed lists from local DB
        // if (previousState.followedListLoadState !== 'success') {
        //     return
        // }

        this.emitMutation({
            activeTab: { $set: 'spaces' },
        })

        if (event.unifiedListId == null) {
            this.options.events?.emit('setSelectedList', null)
            this.emitMutation({ selectedListId: { $set: null } })
            this.renderOpenSpaceInstanceHighlights(previousState)
            return
        }

        await this.setLocallyAvailableSelectedList(
            previousState,
            event.unifiedListId,
        )

        this.renderOwnHighlights(previousState)

        this.emitMutation({})
    }
    changeFetchLocalHTML: EventHandler<'changeFetchLocalHTML'> = async ({
        event,
        previousState,
    }) => {
        // TODO : this is a hack to stop users clicking on space pills before the followed lists have been loaded
        //  Because shit breaks down if they're not loaded and everything's too much of a mess to untangle right now.
        //  Should become much less of a problem once we load followed lists from local DB
        // if (previousState.followedListLoadState !== 'success') {
        //     return
        // }
        this.emitMutation({ fetchLocalHTML: { $set: event.shouldFetch } })
    }

    setSelectedListFromWebUI: EventHandler<
        'setSelectedListFromWebUI'
    > = async ({ event, previousState }) => {
        let nextState = this.applyAndEmitMutation(previousState, {
            activeTab: { $set: 'spaces' },
            loadState: { $set: 'running' },
        })
        await this.options.storageAPI.local.set({
            '@Sidebar-reading_view': true,
        })

        const {
            annotationsCache,
            customListsBG,
            contentSharingBG,
        } = this.options

        const normalizedPageUrl = normalizeUrl(this.fullPageUrl)
        const cachedList = annotationsCache.getListByRemoteId(
            event.sharedListId,
        )

        if (!cachedList.localId) {
            const existingLocalListId = await this.options.contentSharingBG.fetchLocalListDataByRemoteId(
                { remoteListId: event.sharedListId },
            )

            let listInCache = this.options.annotationsCache.getListByRemoteId(
                event.sharedListId,
            )

            listInCache.localId = existingLocalListId
            this.options.annotationsCache.updateList(listInCache)
        }

        // If locally available, proceed as usual
        if (cachedList) {
            nextState = await this.setLocallyAvailableSelectedList(
                nextState,
                cachedList.unifiedId,
            )
            nextState = this.applyAndEmitMutation(nextState, {
                loadState: { $set: 'success' },
            })

            // This covers the case where the associated followedListEntry hasn't been synced yet (via periodic sync, not cloud sync)
            //  for a newly joined page link list
            if (
                event.manuallyPullLocalListData &&
                cachedList.type === 'page-link' &&
                !cachedList.sharedListEntryId
            ) {
                const localData = await customListsBG.fetchLocalDataForRemoteListEntryFromServer(
                    {
                        remoteListId: event.sharedListId,
                        normalizedPageUrl,
                        opts: { needAnnotsFlag: true },
                    },
                )

                if (localData == null) {
                    return
                }

                annotationsCache.updateList({
                    normalizedPageUrl,
                    unifiedId: cachedList.unifiedId,
                    sharedListEntryId: localData.sharedListEntryId,
                    hasRemoteAnnotationsToLoad:
                        localData.hasAnnotationsFromOthers,
                })
                await this.maybeLoadListRemoteAnnotations(
                    { ...nextState, lists: annotationsCache.lists },
                    cachedList.unifiedId,
                )
            }

            this.options.events?.emit('renderHighlights', {
                highlights: cacheUtils.getListHighlightsArray(
                    annotationsCache,
                    cachedList.unifiedId,
                ),
                removeExisting: true,
            })
            return
        }

        if (!this.fullPageUrl) {
            throw new Error(
                'Could not load remote list data for selected list mode without `props.fullPageUrl` being set in sidebar',
            )
        }

        // Else we're dealing with a foreign list which we need to load remotely
        await executeUITask(this, 'foreignSelectedListLoadState', async () => {
            const sharedList = await customListsBG.fetchSharedListDataWithPageAnnotations(
                {
                    remoteListId: event.sharedListId,
                    normalizedPageUrl,
                },
            )
            if (!sharedList) {
                throw new Error(
                    `Could not load remote list data for selected list mode - ID: ${event.sharedListId}`,
                )
            }

            let localListData: {
                localListId?: number
                sharedListEntryId: AutoPk
            }

            if (event.manuallyPullLocalListData) {
                localListData = await customListsBG.fetchLocalDataForRemoteListEntryFromServer(
                    {
                        remoteListId: event.sharedListId,
                        normalizedPageUrl,
                        opts: { needLocalListd: true },
                    },
                )
                if (!localListData) {
                    throw new Error(
                        'Could not find data for local list on cloud',
                    )
                }
                this.emitMutation({
                    hasListDataBeenManuallyPulled: { $set: true },
                })
            }

            let unifiedListId: string
            const listCommon = {
                remoteId: event.sharedListId,
                name: sharedList.title,
                creator: sharedList.creator,
                description: sharedList.description,
                localId: localListData?.localListId ?? undefined,
                isForeignList: localListData == null,
                hasRemoteAnnotationsToLoad:
                    sharedList.sharedAnnotations == null ? false : true,
                unifiedAnnotationIds: [], // Will be populated soon when annots get cached
            }

            if (sharedList.type === 'page-link') {
                const { unifiedId } = annotationsCache.addList<'page-link'>({
                    type: 'page-link',
                    ...listCommon,
                    normalizedPageUrl,
                    sharedListEntryId: localListData?.sharedListEntryId.toString(),
                })
                unifiedListId = unifiedId
            } else {
                const { unifiedId } = annotationsCache.addList<'user-list'>({
                    type: 'user-list',
                    ...listCommon,
                })
                unifiedListId = unifiedId
            }

            this.options.events?.emit('setSelectedList', unifiedListId)

            const buildCoreMutation = (
                sharedAnnotationReferences: SharedAnnotationReference[],
            ): UIMutation<SidebarContainerState> => ({
                loadState: { $set: 'success' },
                selectedListId: { $set: unifiedListId },
                // NOTE: this is the only time we're manually mutating the listInstances state outside the cache subscription - maybe there's a "cleaner" way to do this
                listInstances: {
                    [unifiedListId]: {
                        annotationRefsLoadState: { $set: 'success' },
                        conversationsLoadState: { $set: 'success' },
                        annotationsLoadState: { $set: 'success' },
                        sharedAnnotationReferences: {
                            $set: sharedAnnotationReferences,
                        },
                    },
                },
            })

            if (sharedList.sharedAnnotations == null) {
                this.emitMutation(buildCoreMutation([]))
                return
            }

            const sharedAnnotationUnifiedIds: string[] = []
            const sharedAnnotationReferences: SharedAnnotationReference[] = []
            for (const sharedAnnot of sharedList.sharedAnnotations) {
                const { unifiedId } = annotationsCache.addAnnotation({
                    body: sharedAnnot.body,
                    creator: sharedAnnot.creator,
                    comment: sharedAnnot.comment,
                    lastEdited: sharedAnnot.updatedWhen,
                    createdWhen: sharedAnnot.createdWhen,
                    selector:
                        sharedAnnot.selector != null
                            ? JSON.parse(sharedAnnot.selector)
                            : undefined,
                    remoteId: sharedAnnot.reference.id.toString(),
                    normalizedPageUrl: sharedAnnot.normalizedPageUrl,
                    unifiedListIds: [unifiedListId],
                    privacyLevel: AnnotationPrivacyLevels.SHARED,
                    localListIds: [],
                })
                sharedAnnotationUnifiedIds.push(unifiedId)
                sharedAnnotationReferences.push(sharedAnnot.reference)
            }

            this.emitMutation({
                ...buildCoreMutation(sharedAnnotationReferences),
                conversations: {
                    $merge: fromPairs(
                        sharedAnnotationUnifiedIds.map((unifiedId) => [
                            generateAnnotationCardInstanceId(
                                { unifiedId },
                                unifiedListId,
                            ),
                            getInitialAnnotationConversationState(),
                        ]),
                    ),
                },
            })

            this.options.events?.emit('renderHighlights', {
                highlights: cacheUtils.getListHighlightsArray(
                    annotationsCache,
                    unifiedListId,
                ),
                removeExisting: true,
            })

            await this.detectConversationThreads(
                unifiedListId,
                event.sharedListId,
                sharedAnnotationReferences,
            )
        })
    }

    setAnnotationShareModalShown: EventHandler<
        'setAnnotationShareModalShown'
    > = ({ event }) => {
        this.emitMutation({ showAnnotationsShareModal: { $set: event.shown } })
    }

    setPrivatizeNoteConfirmArgs: EventHandler<
        'setPrivatizeNoteConfirmArgs'
    > = ({ event }) => {
        this.emitMutation({ confirmPrivatizeNoteArgs: { $set: event } })
    }

    setSelectNoteSpaceConfirmArgs: EventHandler<
        'setSelectNoteSpaceConfirmArgs'
    > = ({ event }) => {
        this.emitMutation({ confirmSelectNoteSpaceArgs: { $set: event } })
    }

    setSharingTutorialVisibility: EventHandler<
        'setSharingTutorialVisibility'
    > = async ({ previousState, event }) => {
        await this.showSharingTutorial()
    }

    async showSharingTutorial() {
        const hasEverSharedPageLink = await browser.storage.local.get(
            'hasEverSharedPageLink',
        )

        if (!hasEverSharedPageLink.hasEverSharedPageLink) {
            await browser.storage.local.set({ hasEverSharedPageLink: true })
            this.emitMutation({
                firstTimeSharingPageLink: { $set: true },
            })
            this.emitMutation({
                firstTimeSharingPageLink: {
                    $set: true,
                },
            })
        } else {
            this.emitMutation({
                firstTimeSharingPageLink: {
                    $set: false,
                },
            })
        }
    }

    updateAllAnnotationsShareInfo: EventHandler<
        'updateAllAnnotationsShareInfo'
    > = ({ event }) => {
        const { annotationsCache } = this.options

        for (const annotation of normalizedStateToArray(
            annotationsCache.annotations,
        )) {
            const sharingState = event[annotation?.localId]
            if (!sharingState) {
                continue
            }

            const unifiedListIds = [
                ...sharingState.privateListIds,
                ...sharingState.sharedListIds,
            ]
                .map(
                    (localListId) =>
                        annotationsCache.getListByLocalId(localListId)
                            ?.unifiedId,
                )
                .filter((id) => !!id)

            annotationsCache.updateAnnotation({
                remoteId: sharingState.remoteId
                    ? sharingState.remoteId.toString()
                    : undefined,
                unifiedId: annotation.unifiedId,
                privacyLevel: sharingState.privacyLevel,
                unifiedListIds,
            })
        }
    }

    updateAnnotationShareInfo: EventHandler<
        'updateAnnotationShareInfo'
    > = async ({ previousState, event }) => {
        const existing =
            previousState.annotations.byId[event.unifiedAnnotationId]

        if (existing.privacyLevel === event.privacyLevel) {
            return
        }

        this.options.annotationsCache.updateAnnotation(
            {
                ...existing,
                privacyLevel: event.privacyLevel,
            },
            { keepListsIfUnsharing: event.keepListsIfUnsharing },
        )
    }

    createPageLink: EventHandler<'createPageLink'> = async ({
        previousState,
        event,
    }) => {
        const fullPageUrl = previousState.fullPageUrl

        if (!fullPageUrl) {
            throw new Error(
                'Cannot create page link - Page URL sidebar state not set',
            )
        }
        const currentUser = this.options.getCurrentUser()
        if (!currentUser) {
            throw new Error('Cannot create page link - User not logged in')
        }
        const sharingTutorialP = this.showSharingTutorial()

        let title: string

        if (window.location.href.includes('web.telegram.org')) {
            title = getTelegramUserDisplayName(document, window.location.href)
        }

        const sharedPageListIds = this.options.annotationsCache.getSharedPageListIds(
            normalizeUrl(fullPageUrl),
        )

        let chosenPageLinkList: UnifiedList<'page-link'> = null
        for (const listId of sharedPageListIds) {
            let listData = this.options.annotationsCache.lists.byId[listId]

            // Get the latest page-link list
            if (
                listData?.type === 'page-link' &&
                (listData?.localId > chosenPageLinkList?.localId ||
                    chosenPageLinkList == null)
            ) {
                chosenPageLinkList = listData
            }
        }

        if (chosenPageLinkList) {
            this.emitMutation({
                selectedShareMenuPageLinkList: {
                    $set: chosenPageLinkList.unifiedId,
                },
            })
            if (!event.forceCreate) {
                await sharingTutorialP
                return
            }
        }

        await executeUITask(this, 'pageLinkCreateState', async () => {
            const {
                collabKey,
                listTitle,
                localListId,
                remoteListId,
                remoteListEntryId,
            } = await this.options.contentSharingByTabsBG.schedulePageLinkCreation(
                {
                    fullPageUrl,
                    customPageTitle: title,
                },
            )

            const cacheListData: UnifiedListForCache<'page-link'> = {
                type: 'page-link',
                name: listTitle,
                creator: currentUser,
                localId: localListId,
                collabKey: collabKey.toString(),
                remoteId: remoteListId.toString(),
                sharedListEntryId: remoteListEntryId.toString(),
                normalizedPageUrl: normalizeUrl(fullPageUrl),
                unifiedAnnotationIds: [],
                hasRemoteAnnotationsToLoad: false,
                isPrivate: false,
            }
            this.emitMutation({
                pageListDataForCurrentPage: { $set: cacheListData },
            })
            const { unifiedId } = this.options.annotationsCache.addList(
                cacheListData,
            )

            this.emitMutation({
                selectedShareMenuPageLinkList: { $set: unifiedId },
            })

            await Promise.all([
                this.options.contentSharingBG.waitForPageLinkCreation(),
                this.setLocallyAvailableSelectedList(
                    {
                        ...previousState,
                        lists: this.options.annotationsCache.lists,
                        listInstances: {
                            ...previousState.listInstances,
                            [unifiedId]: initListInstance({
                                ...cacheListData,
                                unifiedId,
                            }),
                        },
                    },
                    unifiedId,
                ),
            ])
        })
        await sharingTutorialP
    }
}
