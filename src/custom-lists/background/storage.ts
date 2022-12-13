import cloneDeep from 'lodash/cloneDeep'
import {
    StorageModule,
    StorageModuleConfig,
} from '@worldbrain/storex-pattern-modules'
import {
    COLLECTION_DEFINITIONS,
    COLLECTION_NAMES,
    SPECIAL_LIST_NAMES,
    SPECIAL_LIST_IDS,
} from '@worldbrain/memex-common/lib/storage/modules/lists/constants'

import { SuggestPlugin } from 'src/search/plugins'
import type { SuggestResult } from 'src/search/types'
import type { PageList, PageListEntry, ListDescription } from './types'
import { STORAGE_VERSIONS } from 'src/storage/constants'
import { DEFAULT_TERM_SEPARATOR } from '@worldbrain/memex-stemmer/lib/constants'

export default class CustomListStorage extends StorageModule {
    static LIST_DESCRIPTIONS_COLL = COLLECTION_NAMES.listDescription
    static CUSTOM_LISTS_COLL = COLLECTION_NAMES.list
    static LIST_ENTRIES_COLL = COLLECTION_NAMES.listEntry

    static filterOutSpecialListEntries = (entry: { listId: number }) =>
        !Object.values<number>(SPECIAL_LIST_IDS).includes(entry.listId)
    static filterOutSpecialLists = (list: { name: string }) =>
        !Object.values<string>(SPECIAL_LIST_NAMES).includes(list.name)

    getConfig(): StorageModuleConfig {
        const collections = cloneDeep(
            COLLECTION_DEFINITIONS,
        ) as typeof COLLECTION_DEFINITIONS
        collections[COLLECTION_NAMES.listDescription].version =
            STORAGE_VERSIONS[20].version
        collections[COLLECTION_NAMES.listEntryDescription].version =
            STORAGE_VERSIONS[20].version

        return {
            collections,
            operations: {
                createList: {
                    collection: CustomListStorage.CUSTOM_LISTS_COLL,
                    operation: 'createObject',
                },
                createListEntry: {
                    collection: CustomListStorage.LIST_ENTRIES_COLL,
                    operation: 'createObject',
                },
                createListDescription: {
                    collection: CustomListStorage.LIST_DESCRIPTIONS_COLL,
                    operation: 'createObject',
                },
                countListEntries: {
                    collection: CustomListStorage.LIST_ENTRIES_COLL,
                    operation: 'countObjects',
                    args: { listId: '$listId:int' },
                },
                findListsIncluding: {
                    collection: CustomListStorage.CUSTOM_LISTS_COLL,
                    operation: 'findObjects',
                    args: {
                        id: { $in: '$includedIds:array' },
                    },
                },
                findLists: {
                    collection: CustomListStorage.CUSTOM_LISTS_COLL,
                    operation: 'findObjects',
                    args: [
                        {},
                        {
                            limit: '$limit:int',
                            skip: '$skip:int',
                        },
                    ],
                },
                findListById: {
                    collection: CustomListStorage.CUSTOM_LISTS_COLL,
                    operation: 'findObject',
                    args: { id: '$id:pk' },
                },
                findListsByIds: {
                    collection: CustomListStorage.CUSTOM_LISTS_COLL,
                    operation: 'findObjects',
                    args: { id: { $in: '$ids:array' } },
                },
                findListEntriesByListId: {
                    collection: CustomListStorage.LIST_ENTRIES_COLL,
                    operation: 'findObjects',
                    args: { listId: '$listId:int' },
                },
                findListEntriesByUrl: {
                    collection: CustomListStorage.LIST_ENTRIES_COLL,
                    operation: 'findObjects',
                    args: { pageUrl: '$url:string' },
                },
                findListEntriesByUrls: {
                    collection: CustomListStorage.LIST_ENTRIES_COLL,
                    operation: 'findObjects',
                    args: {
                        listId: '$listId:number',
                        pageUrl: { $in: '$urls:string' },
                    },
                },
                findListEntriesByLists: {
                    collection: CustomListStorage.LIST_ENTRIES_COLL,
                    operation: 'findObjects',
                    args: {
                        listId: { $in: '$listIds:array' },
                        pageUrl: '$url:string',
                    },
                },
                findListEntry: {
                    collection: CustomListStorage.LIST_ENTRIES_COLL,
                    operation: 'findObject',
                    args: { pageUrl: '$pageUrl:string', listId: '$listId:int' },
                },
                findListByNameIgnoreCase: {
                    collection: CustomListStorage.CUSTOM_LISTS_COLL,
                    operation: 'findObject',
                    args: [{ name: '$name:string' }, { ignoreCase: ['name'] }],
                },
                findListsByNames: {
                    collection: CustomListStorage.CUSTOM_LISTS_COLL,
                    operation: 'findObjects',
                    args: { name: { $in: '$name:string[]' } },
                },
                findListDescriptionByList: {
                    collection: CustomListStorage.LIST_DESCRIPTIONS_COLL,
                    operation: 'findObject',
                    args: { listId: '$listId:pk' },
                },
                findListDescriptionsByLists: {
                    collection: CustomListStorage.LIST_DESCRIPTIONS_COLL,
                    operation: 'findObjects',
                    args: { listId: { $in: '$listIds:array' } },
                },
                updateListName: {
                    collection: CustomListStorage.CUSTOM_LISTS_COLL,
                    operation: 'updateObject',
                    args: [
                        {
                            id: '$id:pk',
                        },
                        {
                            name: '$name:string',
                            searchableName: '$name:string',
                            // updatedAt: '$updatedAt:any',
                        },
                    ],
                },
                updateListDescription: {
                    collection: CustomListStorage.LIST_DESCRIPTIONS_COLL,
                    operation: 'updateObject',
                    args: [
                        { listId: '$listId:pk' },
                        { description: '$description:string' },
                    ],
                },
                deleteList: {
                    collection: CustomListStorage.CUSTOM_LISTS_COLL,
                    operation: 'deleteObject',
                    args: { id: '$id:pk' },
                },
                deleteListEntriesByListId: {
                    collection: CustomListStorage.LIST_ENTRIES_COLL,
                    operation: 'deleteObjects',
                    args: { listId: '$listId:pk' },
                },
                deleteListEntriesById: {
                    collection: CustomListStorage.LIST_ENTRIES_COLL,
                    operation: 'deleteObjects',
                    args: { listId: '$listId:pk', pageUrl: '$pageUrl:string' },
                },
                deleteListDescription: {
                    collection: CustomListStorage.LIST_DESCRIPTIONS_COLL,
                    operation: 'deleteObject',
                    args: { listId: '$listId:pk' },
                },
                [SuggestPlugin.SUGGEST_OBJS_OP_ID]: {
                    operation: SuggestPlugin.SUGGEST_OBJS_OP_ID,
                    args: {
                        collection: '$collection:string',
                        query: '$query:string',
                        options: '$options:any',
                    },
                },
            },
        }
    }

    private prepareList(
        list: PageList,
        pages: string[] = [],
        active: boolean = false,
    ): PageList {
        delete list['_name_terms']

        return {
            ...list,
            pages,
            active,
        }
    }

    async createListDescription({
        listId,
        description,
    }: {
        listId: number
        description: string
    }): Promise<void> {
        await this.operation('createListDescription', { listId, description })
    }

    async createInboxListIfAbsent({
        createdAt = new Date(),
    }: {
        createdAt?: Date
    }): Promise<number> {
        const foundInboxList = await this.operation(
            'findListByNameIgnoreCase',
            { name: SPECIAL_LIST_NAMES.INBOX },
        )
        if (foundInboxList) {
            return foundInboxList.id
        }

        return (
            await this.operation('createList', {
                name: SPECIAL_LIST_NAMES.INBOX,
                id: SPECIAL_LIST_IDS.INBOX,
                searchableName: SPECIAL_LIST_NAMES.INBOX,
                isDeletable: false,
                isNestable: false,
                createdAt,
            })
        ).object.id
    }

    countListEntries(listId: number): Promise<number> {
        return this.operation('countListEntries', { listId })
    }

    countInboxUnread(): Promise<number> {
        return this.countListEntries(SPECIAL_LIST_IDS.INBOX)
    }

    async fetchListDescriptionByList(
        listId: number,
    ): Promise<ListDescription | null> {
        return this.operation('findListDescriptionByList', { listId })
    }

    async fetchAllLists({
        limit,
        skip,
        skipMobileList,
        includeDescriptions,
    }: {
        limit: number
        skip: number
        skipMobileList?: boolean
        includeDescriptions?: boolean
    }) {
        const lists: PageList[] = await this.operation('findLists', {
            limit,
            skip,
        })

        if (includeDescriptions) {
            const descriptions: ListDescription[] = await this.operation(
                'findListDescriptionsByLists',
                { listIds: lists.map((list) => list.id) },
            )
            const descriptionsById = descriptions.reduce(
                (acc, curr) => ({ ...acc, [curr.listId]: curr.description }),
                {},
            )
            for (const list of lists) {
                list.description = descriptionsById[list.id]
            }
        }

        const prepared = lists.map((list) => this.prepareList(list))

        if (skipMobileList) {
            return prepared.filter(CustomListStorage.filterOutSpecialLists)
        }

        return prepared
    }

    async fetchListById(id: number): Promise<PageList | null> {
        return this.operation('findListById', { id })
    }

    async fetchListByIds(ids: number[]): Promise<PageList[]> {
        const listsData: PageList[] = await this.operation('findListsByIds', {
            ids,
        })
        const orderedLists: PageList[] = []

        for (const listId of new Set(ids)) {
            const data = listsData.find((list) => list.id === listId)
            if (data) {
                orderedLists.push(data)
            }
        }

        return orderedLists
    }

    async fetchListWithPagesById(id: number) {
        const list = await this.fetchListById(id)

        if (!list) {
            return null
        }

        const pages = await this.fetchListPagesById({ listId: list.id })

        return this.prepareList(
            list,
            pages.map((p) => p.fullUrl),
            pages.length > 0,
        )
    }

    async fetchListEntry(
        listId: number,
        pageUrl: string,
    ): Promise<PageListEntry | null> {
        return this.operation('findListEntry', { listId, pageUrl })
    }

    async fetchListPagesById({
        listId,
    }: {
        listId: number
    }): Promise<PageListEntry[]> {
        return this.operation('findListEntriesByListId', { listId })
    }

    async fetchListIdsByUrl(url: string): Promise<number[]> {
        const entries = await this.operation('findListEntriesByUrl', { url })
        return entries.map((entry) => entry.listId)
    }

    async fetchListPagesByUrl({ url }: { url: string }) {
        const pageEntries = await this.operation('findListEntriesByUrl', {
            url,
        })

        const entriesByListId = new Map<number, any[]>()
        const listIds = new Set<string>()

        pageEntries
            .filter(CustomListStorage.filterOutSpecialListEntries)
            .forEach((entry) => {
                listIds.add(entry.listId)
                const current = entriesByListId.get(entry.listId) || []
                entriesByListId.set(entry.listId, [...current, entry.fullUrl])
            })

        const lists: PageList[] = (
            await this.operation('findListsIncluding', {
                includedIds: [...listIds],
            })
        ).filter(CustomListStorage.filterOutSpecialLists)

        return lists.map((list) => {
            const entries = entriesByListId.get(list.id)
            return this.prepareList(list, entries, entries != null)
        })
    }

    async fetchPageListEntriesByUrl({
        normalizedPageUrl,
    }: {
        normalizedPageUrl: string
    }) {
        const pageListEntries: PageListEntry[] = await this.operation(
            'findListEntriesByUrl',
            { url: normalizedPageUrl },
        )
        return pageListEntries
    }

    async fetchListPageEntriesByUrls({
        listId,
        normalizedPageUrls,
    }: {
        listId: number
        normalizedPageUrls: string[]
    }) {
        const pageListEntries: PageListEntry[] = await this.operation(
            'findListEntriesByUrls',
            { urls: normalizedPageUrls, listId },
        )
        return pageListEntries
    }

    async insertCustomList({
        id,
        type,
        name,
        isDeletable = true,
        isNestable = true,
        createdAt = new Date(),
    }: {
        id: number
        type?: string
        name: string
        isDeletable?: boolean
        isNestable?: boolean
        createdAt?: Date
    }): Promise<number> {
        const { object } = await this.operation('createList', {
            id,
            name,
            type,
            isNestable,
            isDeletable,
            searchableName: name,
            createdAt,
        })

        return object.id
    }

    async updateListName({
        id,
        name,
        updatedAt = new Date(),
    }: {
        id: number
        name: string
        updatedAt?: Date
    }) {
        return this.operation('updateListName', {
            id,
            name,
            // updatedAt,
        })
    }

    async createOrUpdateListDescription({
        listId,
        description,
    }: {
        listId: number
        description: string
    }): Promise<void> {
        const existing = await this.fetchListDescriptionByList(listId)
        await this.operation(
            existing ? 'updateListDescription' : 'createListDescription',
            { listId, description },
        )
    }

    async removeList({ id }: { id: number }) {
        const pages = await this.operation('deleteListEntriesByListId', {
            listId: id,
        })
        const list = await this.operation('deleteList', { id })
        return { list, pages }
    }

    async insertPageToList({
        listId,
        pageUrl,
        fullUrl,
        createdAt = new Date(),
    }: {
        listId: number
        pageUrl: string
        fullUrl: string
        createdAt?: Date
    }) {
        const idExists = Boolean(await this.fetchListById(listId))

        if (idExists) {
            return this.operation('createListEntry', {
                listId,
                pageUrl,
                fullUrl,
                createdAt,
            })
        }
    }

    async removePageFromList({
        listId,
        pageUrl,
    }: {
        listId: number
        pageUrl: string
    }) {
        return this.operation('deleteListEntriesById', { listId, pageUrl })
    }

    async deleteListDescription({ listId }: { listId: number }): Promise<void> {
        await this.operation('deleteListDescription', { listId })
    }

    async suggestLists({
        query,
        limit = 20,
    }: {
        query: string
        limit?: number
    }): Promise<PageList[]> {
        // Ensure any term delimiters replaced with spaces
        const formattedQuery = query.replace(DEFAULT_TERM_SEPARATOR, ' ')

        const suggestions: SuggestResult<string, number> = await this.operation(
            SuggestPlugin.SUGGEST_OBJS_OP_ID,
            {
                collection: CustomListStorage.CUSTOM_LISTS_COLL,
                query: { nameTerms: formattedQuery },
                options: {
                    multiEntryAssocField: 'name',
                    ignoreCase: ['nameTerms'],
                    limit,
                },
            },
        )

        const suggestedLists: PageList[] = await this.operation(
            'findListsIncluding',
            {
                includedIds: suggestions.map(({ pk }) => pk),
            },
        )

        return suggestedLists.filter(CustomListStorage.filterOutSpecialLists)
    }

    async fetchListIgnoreCase({ name }: { name: string }) {
        return this.operation('findListByNameIgnoreCase', { name })
    }
}
