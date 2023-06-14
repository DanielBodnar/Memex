import { EventEmitter } from 'events'
import type TypedEventEmitter from 'typed-emitter'

import type { MaybePromise } from 'src/util/types'
import type {
    SharedInPageUIInterface,
    SharedInPageUIEvents,
    InPageUIComponentShowState,
    InPageUIComponent,
    InPageUIRibbonAction,
    SidebarActionOptions,
    ShouldSetUpOptions,
} from './types'
import {
    getRemoteEventEmitter,
    TypedRemoteEventEmitter,
} from 'src/util/webextensionRPC'
import type { ContentSharingEvents } from 'src/content-sharing/background/types'
import * as sidebarUtils from 'src/sidebar-overlay/utils'

export interface SharedInPageUIDependencies {
    getNormalizedPageUrl: () => MaybePromise<string>
    loadComponent: (component: InPageUIComponent) => void
    unloadComponent: (component: InPageUIComponent) => void
}

/**
 * This class controls the UI state for main components of a given page.
 *
 * All main UI components lke the sidebar and ribbon should receive a shared
 * instance of this class and will subscribe to changes against it.
 *
 */
export class SharedInPageUIState implements SharedInPageUIInterface {
    contentSharingEvents: TypedRemoteEventEmitter<'contentSharing'>
    summarisePageEvents: TypedRemoteEventEmitter<'pageSummary'>
    events = new EventEmitter() as TypedEventEmitter<SharedInPageUIEvents>
    componentsShown: InPageUIComponentShowState = {
        ribbon: false,
        sidebar: false,
        tooltip: false,
        highlights: false,
    }
    componentsSetUp: InPageUIComponentShowState = {
        ribbon: false,
        sidebar: false,
        tooltip: false,
        highlights: false,
    }

    ribbonEnabled = null

    /**
     * Keep track of currently selected space for other UI elements to follow.
     *
     * Other main UI components may be interested in this to know, for
     * instance, how what is the selected space for creating new annotations.
     *
     * The actual original source of truth for this is the
     * AnnotationSidebarContainer selectedList state value. That is
     * propagated to AnnotationSidebarInPage using selectedListChanged
     * UIlogic event, which will then update this value here.
     *
     */
    selectedList: SharedInPageUIInterface['selectedList'] = null

    _pendingEvents: {
        sidebarAction?: {
            emittedWhen: number
        } & SidebarActionOptions
        ribbonAction?: { emittedWhen: number; action: InPageUIRibbonAction }
    } = {}

    constructor(private options: SharedInPageUIDependencies) {
        this.events.on('newListener' as any, this._handleNewListener)

        this.contentSharingEvents = getRemoteEventEmitter('contentSharing')

        this.contentSharingEvents.on(
            'pageAddedToSharedList',
            this.handlePageAddedToSharedList,
        )

        this.summarisePageEvents = getRemoteEventEmitter('pageSummary')
    }

    private handlePageAddedToSharedList: ContentSharingEvents['pageAddedToSharedList'] = async ({
        pageUrl,
    }) => {
        if (pageUrl !== (await this.options.getNormalizedPageUrl())) {
            return
        }

        this._emitAction({
            type: 'sidebarAction',
            action: 'set_sharing_access',
            annotationSharingAccess: 'sharing-allowed',
        })
    }

    _handleNewListener = (
        eventName: keyof SharedInPageUIEvents,
        listener: (...args: any[]) => void,
    ) => {
        if (eventName !== 'ribbonAction' && eventName !== 'sidebarAction') {
            return
        }

        if (!this._pendingEvents[eventName]) {
            return
        }

        // If this event was emitted less than 5 seconds ago
        if (
            this._pendingEvents[eventName].emittedWhen >
            Date.now() - 1000 * 5
        ) {
            listener(this._pendingEvents[eventName] as any)
        }

        delete this._pendingEvents[eventName]
    }

    async testIfSidebarSetup() {
        return true
    }

    async showSidebar(options?: SidebarActionOptions) {
        const maybeEmitAction = () => {
            if (options?.action) {
                this._emitAction({
                    type: 'sidebarAction',
                    ...options,
                })
            }
        }

        if (this.componentsShown.sidebar) {
            maybeEmitAction()
            return
        }

        if (!this.componentsShown.ribbon) {
            await this.showRibbon()
        }

        await this._setState('sidebar', true)
        maybeEmitAction()
    }

    _emitAction(
        params:
            | ({
                  type: 'sidebarAction'
              } & SidebarActionOptions)
            | { type: 'ribbonAction'; action: InPageUIRibbonAction },
    ) {
        const handled =
            params.type === 'sidebarAction'
                ? this.events.emit('sidebarAction', params)
                : this.events.emit('ribbonAction', params)

        if (!handled) {
            this._pendingEvents[params.type] = {
                ...params,
                emittedWhen: Date.now(),
            } as any
        }
    }

    async hideSidebar() {
        await this._setState('sidebar', false)
    }

    async toggleSidebar() {
        if (this.componentsShown.sidebar) {
            await this.hideSidebar()
        } else {
            await this.showSidebar({ action: 'comment' })
        }
    }

    async loadComponent(
        component: InPageUIComponent,
        options: ShouldSetUpOptions = {},
    ) {
        // NOTE: The loadComponent call is not async, though if you remove the await then the `componentShouldSetUp` event
        //  gets sent off too early and the components won't properly receive it. Adding setTimeout(0) to the following call
        //  doesn't seem to fix it as simply putting await does.
        // TODO: fix this - could indicate a deeper timing issue
        await this.options.loadComponent(component)
        this._maybeEmitShouldSetUp(component, options)
        return
    }

    async showRibbon(options?: { action?: InPageUIRibbonAction }) {
        this.ribbonEnabled = await sidebarUtils.getSidebarState()
        const maybeEmitAction = () => {
            if (options?.action) {
                this._emitAction({
                    type: 'ribbonAction',
                    action: options.action,
                })
            }
        }

        if (this.componentsShown.ribbon) {
            maybeEmitAction()
            return
        }

        await this._setState('ribbon', true)
        maybeEmitAction()
    }

    async hideRibbon() {
        this.ribbonEnabled = await sidebarUtils.getSidebarState()
        await this._setState('ribbon', false)
        if (!this.ribbonEnabled) {
            await this._removeComponent('ribbon')
        }
    }

    async removeRibbon() {
        if (this.componentsSetUp.sidebar) {
            await this._removeComponent('sidebar')
        }
        await this._removeComponent('ribbon')
    }

    async reloadRibbon() {
        await this.reloadComponent('ribbon')
        await this.reloadComponent('sidebar')
    }

    async toggleRibbon() {
        if (this.componentsShown.ribbon) {
            await this.hideRibbon()
        } else {
            await this.showRibbon()
        }
    }

    updateRibbon() {
        this.events.emit('ribbonUpdate')
    }

    async setupTooltip() {
        await this.loadComponent('tooltip')
    }

    async showTooltip() {
        await this._setState('tooltip', true)
    }

    async hideTooltip() {
        await this._setState('tooltip', false)
    }

    async removeTooltip() {
        await this._removeComponent('tooltip')
    }

    async toggleTooltip() {
        if (this.componentsSetUp.tooltip) {
            await this.removeTooltip()
        } else {
            await this.showTooltip()
        }
    }

    async hideHighlights() {
        await this._setState('highlights', false)
    }

    async showHighlights() {
        await this._setState('highlights', true)
    }

    async toggleHighlights() {
        if (this.componentsShown.highlights) {
            await this.hideHighlights()
        } else {
            await this.showHighlights()
        }
    }

    private async _setState(component: InPageUIComponent, visible: boolean) {
        if (this.componentsShown[component] === visible) {
            return
        }

        if (visible) {
            await this.loadComponent(component, {
                showSidebarOnLoad: component === 'sidebar',
            })
        }

        this.componentsShown[component] = visible

        this.events.emit('stateChanged', {
            newState: this.componentsShown,
            changes: { [component]: this.componentsShown[component] },
        })
    }

    _removeComponent(component: InPageUIComponent) {
        this.options.unloadComponent(component)
        this.componentsShown[component] = false
        this.componentsSetUp[component] = false
        this.events.emit('componentShouldDestroy', { component })
    }

    async reloadComponent(
        component: InPageUIComponent,
        options: ShouldSetUpOptions = {},
    ) {
        await this.options.loadComponent(component)
        this.events.emit('componentShouldSetUp', { component, options })
    }

    private _maybeEmitShouldSetUp(
        component: InPageUIComponent,
        options: ShouldSetUpOptions = {},
    ) {
        if (!this.componentsSetUp[component]) {
            this.events.emit('componentShouldSetUp', { component, options })
            this.componentsSetUp[component] = true
        }
    }

    toggleErrorMessage: SharedInPageUIInterface['toggleErrorMessage'] = async ({
        type,
    }) => {
        // Ensure ribbon is loaded so we can display the error in the ribbon holder's React DOM
        await this.loadComponent('ribbon', {
            keepRibbonHidden: true,
            inPageErrorType: type,
        })
        this.events.emit('displayErrorMessage', { type })
    }
}
