import type { ContentConversationsInterface } from './types'
import type { ServerStorageModules } from 'src/storage/types'
import type { Services } from 'src/services/types'
import type { ContentConversationsBackendInterface } from '@worldbrain/memex-common/lib/content-conversations/backend/types'
import { makeRemotelyCallable } from 'src/util/webextensionRPC'

export default class ContentConversationsBackground {
    remoteFunctions: ContentConversationsInterface

    constructor(
        private options: {
            backend: ContentConversationsBackendInterface
            services: Pick<Services, 'contentConversations'>
            serverStorage: Pick<ServerStorageModules, 'contentConversations'>
        },
    ) {
        this.remoteFunctions = {
            submitReply: async (params) => {
                const result = await this.options.backend.createReply(params)
                if (result.status === 'permission-denied') {
                    return { status: 'not-authenticated' }
                }
                return result
            },
            editReply: async (params) => {
                const { contentConversations } = options.services
                return contentConversations.editReply(params)
            },
            deleteReply: async (params) => {
                const { contentConversations } = options.services
                return contentConversations.deleteReply(params)
            },
            getThreadsForSharedAnnotations: async ({
                sharedAnnotationReferences,
                sharedListReference,
            }) => {
                return this.options.backend.getThreadsForAnnotations({
                    annotationReferences: sharedAnnotationReferences,
                    sharedListReference,
                })
            },
            getRepliesBySharedAnnotation: async ({
                sharedAnnotationReference,
                sharedListReference,
            }) => {
                return this.options.backend.getRepliesByAnnotation({
                    annotationReference: sharedAnnotationReference,
                    sharedListReference,
                })
            },
            getOrCreateThread: async ({
                sharedAnnotationReference,
                ...params
            }) => {
                return this.options.backend.getOrCreateThread({
                    ...params,
                    annotationReference: sharedAnnotationReference,
                })
            },
        }
    }

    setupRemoteFunctions() {
        makeRemotelyCallable(this.remoteFunctions)
    }
}
