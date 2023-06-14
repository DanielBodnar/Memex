import type TypedEventEmitter from 'typed-emitter'
import type { Anchor } from 'src/highlighting/types'
import type { AnnotationSharingAccess } from 'src/content-sharing/ui/types'
import type {
    UnifiedAnnotation,
    UnifiedList,
} from 'src/annotations/cache/types'

export type InPageUISidebarAction =
    | 'comment'
    | 'edit_annotation'
    | 'edit_annotation_spaces'
    | 'show_annotation'
    | 'set_sharing_access'
    | 'show_shared_spaces'
    | 'selected_list_mode_from_web_ui'
    | 'show_my_annotations'
    | 'check_sidebar_status'
    | 'show_page_summary'

export type InPageUIRibbonAction = 'comment' | 'tag' | 'list' | 'bookmark'
export type InPageUIComponent = 'ribbon' | 'sidebar' | 'tooltip' | 'highlights'
export type InPageUIComponentShowState = {
    [Component in InPageUIComponent]: boolean
}

export interface IncomingAnnotationData {
    highlightText?: string
    commentText?: string
    isBookmarked?: boolean
    tags?: string[]
}

// TODO: Improve this type so possible fields depend on `action` type
export interface SidebarActionOptions {
    action: InPageUISidebarAction
    anchor?: Anchor
    annotationLocalId?: string
    /** Set this for 'selected_list_mode_from_web_ui' */
    sharedListId?: string
    annotationCacheId?: UnifiedAnnotation['unifiedId']
    annotationData?: IncomingAnnotationData
    annotationSharingAccess?: AnnotationSharingAccess
    highlightedText?: string
}

export type InPageErrorType = 'annotation' // Add more specific error types here

export interface SharedInPageUIEvents {
    stateChanged: (event: {
        newState: InPageUIComponentShowState
        changes: Partial<InPageUIComponentShowState>
    }) => void
    ribbonAction: (event: { action: InPageUIRibbonAction }) => void
    ribbonUpdate: () => void
    sidebarAction: (event: SidebarActionOptions) => void
    componentShouldSetUp: (event: {
        component: InPageUIComponent
        options?: ShouldSetUpOptions
    }) => void
    componentShouldDestroy: (event: { component: InPageUIComponent }) => void
    displayErrorMessage: (event: { type: InPageErrorType }) => void
}

export interface ShouldSetUpOptions {
    keepRibbonHidden?: boolean
    showSidebarOnLoad?: boolean
    showPageActivityIndicator?: boolean
    inPageErrorType?: InPageErrorType
    openInAIMode?: boolean
}

export interface SharedInPageUIInterface {
    events: TypedEventEmitter<SharedInPageUIEvents>
    componentsShown: InPageUIComponentShowState
    selectedList: UnifiedList['unifiedId'] | null

    // Ribbon
    showRibbon(options?: { action?: InPageUIRibbonAction }): Promise<void>
    hideRibbon(): Promise<void>
    removeRibbon(): Promise<void>
    toggleRibbon(): Promise<void>
    updateRibbon(): void

    // Sidebar
    showSidebar(options?: SidebarActionOptions): Promise<void>
    hideSidebar(): Promise<void>
    toggleSidebar(): Promise<void>

    // Tooltip
    showTooltip(): Promise<void>
    hideTooltip(): Promise<void>
    setupTooltip(): Promise<void>
    removeTooltip(): Promise<void>
    toggleTooltip(): Promise<void>

    // Highlights
    showHighlights(): Promise<void>
    hideHighlights(): Promise<void>
    toggleHighlights(): Promise<void>

    toggleErrorMessage(args: { type: InPageErrorType }): Promise<void>
}
