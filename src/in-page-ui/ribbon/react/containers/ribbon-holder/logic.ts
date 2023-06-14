import { UILogic, UIEvent, UIEventHandler } from 'ui-logic-core'
import type { RibbonContainerDependencies } from '../ribbon/types'
import type {
    SharedInPageUIInterface,
    InPageUIComponentShowState,
    ShouldSetUpOptions,
    InPageErrorType,
} from 'src/in-page-ui/shared-state/types'

export interface RibbonHolderState {
    state: 'visible' | 'hidden'
    isSidebarOpen: boolean
    keepPageActivityIndicatorHidden: boolean
    isRibbonEnabled?: boolean
    ribbonPosition: 'topRight' | 'bottomRight' | 'centerRight'
    inPageErrorType?: InPageErrorType
}

export type RibbonHolderEvents = UIEvent<{
    show: null
    hide: null
    setInPageError: { type?: InPageErrorType }
    openSidebarToSharedSpaces: null
    selectRibbonPositionOption: null
}>

export interface RibbonHolderDependencies {
    setUpOptions: ShouldSetUpOptions
    inPageUI: SharedInPageUIInterface
    containerDependencies: RibbonContainerDependencies
}

type EventHandler<EventName extends keyof RibbonHolderEvents> = UIEventHandler<
    RibbonHolderState,
    RibbonHolderEvents,
    EventName
>

export class RibbonHolderLogic extends UILogic<
    RibbonHolderState,
    RibbonHolderEvents
> {
    constructor(private dependencies: RibbonHolderDependencies) {
        super()
    }

    getInitialState(): RibbonHolderState {
        return {
            state: this.dependencies.inPageUI.componentsShown.ribbon
                ? 'visible'
                : 'hidden',
            isSidebarOpen: this.dependencies.inPageUI.componentsShown.sidebar,
            keepPageActivityIndicatorHidden: false,
            ribbonPosition: null,
        }
    }

    init: EventHandler<'init'> = async ({ previousState }) => {
        this.dependencies.inPageUI.events.on(
            'stateChanged',
            this._handleUIStateChange,
        )

        const ribbonPosition = await this.dependencies.containerDependencies.syncSettings.inPageUI.get(
            'ribbonPosition',
        )

        this.emitMutation({
            ribbonPosition: {
                $set: ribbonPosition ?? 'bottomRight',
            },
        })

        if (ribbonPosition == null) {
            await this.dependencies.containerDependencies.syncSettings.inPageUI.set(
                'ribbonPosition',
                'bottomRight',
            )
        }

        // await loadInitial<RibbonHolderState>(this, async () => {
        //     await this._maybeLoad(previousState, {})
        // })
    }

    cleanup() {
        this.dependencies.inPageUI.events.removeListener(
            'stateChanged',
            this._handleUIStateChange,
        )
    }

    selectRibbonPositionOption: EventHandler<
        'selectRibbonPositionOption'
    > = async ({ event }) => {
        const ribbonPosition = await this.dependencies.containerDependencies.syncSettings.inPageUI.set(
            'ribbonPosition',
            event,
        )

        this.emitMutation({
            ribbonPosition: {
                $set: event,
            },
        })

        // return this.dependencies.customLists.addOpenTabsToList({
        //     listId: event?.value,
        // })
    }

    show: EventHandler<'show'> = () => {
        return { state: { $set: 'visible' } }
    }

    hide: EventHandler<'hide'> = () => {
        return { state: { $set: 'hidden' } }
    }

    setInPageError: EventHandler<'setInPageError'> = async ({ event }) => {
        console.log('setInPageError', event)

        if (event == null) {
            this.emitMutation({ inPageErrorType: { $set: null } })
        } else {
            this.emitMutation({ inPageErrorType: { $set: event.type } })
        }
    }

    openSidebarToSharedSpaces: EventHandler<
        'openSidebarToSharedSpaces'
    > = async ({}) => {
        this.emitMutation({
            keepPageActivityIndicatorHidden: { $set: true },
        })
        await this.dependencies.inPageUI.showSidebar({
            action: 'show_shared_spaces',
        })
    }

    _handleUIStateChange = (event: {
        newState: InPageUIComponentShowState
    }) => {
        this.emitMutation({ isSidebarOpen: { $set: event.newState.sidebar } })

        if (event.newState.sidebar === true) {
            this.emitMutation({
                keepPageActivityIndicatorHidden: { $set: true },
            })
        }
    }
}
