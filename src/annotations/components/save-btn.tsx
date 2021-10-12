import React from 'react'
import styled from 'styled-components'

import { getKeyName } from 'src/util/os-specific-key-names'
import Margin from 'src/dashboard-refactor/components/Margin'
import Icon from '@worldbrain/memex-common/lib/common-ui/components/icon'
import { DropdownMenuBtn } from 'src/common-ui/components/dropdown-menu-btn'
import SharePrivacyOption from 'src/overview/sharing/components/SharePrivacyOption'

export interface Props {
    isShared?: boolean
    isProtected?: boolean
    onSave: (
        shouldShare: boolean,
        isProtected?: boolean,
    ) => void | Promise<void>
}

interface State {
    isPrivacyLevelShown: boolean
}

export default class AnnotationSaveBtn extends React.PureComponent<
    Props,
    State
> {
    state: State = { isPrivacyLevelShown: false }

    private saveWithShareIntent = (shouldShare: boolean) => (
        isProtected?: boolean,
    ) => this.props.onSave(shouldShare, isProtected)

    render() {
        return (
            <SaveBtn>
                <SaveBtnText onClick={() => this.props.onSave(false)}>
                    <Icon
                        icon={
                            this.props.isProtected
                                ? 'lock'
                                : this.props.isShared
                                ? 'shared'
                                : 'person'
                        }
                        height="14px"
                    />{' '}
                    Save
                </SaveBtnText>
                <SaveBtnArrow horizontal="1px">
                    <DropdownMenuBtn
                        btnChildren={<Icon icon="triangle" height="8px" />}
                        isOpen={this.state.isPrivacyLevelShown}
                        toggleOpen={() =>
                            this.setState((state) => ({
                                isPrivacyLevelShown: !state.isPrivacyLevelShown,
                            }))
                        }
                    >
                        <SharePrivacyOption
                            hasProtectedOption
                            icon="shared"
                            title="Shared"
                            shortcut={`shift+${getKeyName({
                                key: 'alt',
                            })}+enter`}
                            description="Added to shared collections this page is in"
                            onClick={this.saveWithShareIntent(true)}
                            isSelected={this.props.isShared}
                        />
                        <SharePrivacyOption
                            hasProtectedOption
                            icon="person"
                            title="Private"
                            shortcut={`${getKeyName({ key: 'mod' })}+enter`}
                            description="Private to you, until shared (in bulk)"
                            onClick={this.saveWithShareIntent(false)}
                            isSelected={!this.props.isShared}
                        />
                    </DropdownMenuBtn>
                </SaveBtnArrow>
            </SaveBtn>
        )
    }
}

const SaveBtn = styled.div`
    display: flex;
    flex-direction: row;
    align-item: center;
    box-sizing: border-box;
    cursor: pointer;
    font-size: 14px;
    border: none;
    outline: none;
    padding: 3px 0 3px 5px;
    margin-right: 5px;
    background: transparent;
    border-radius: 3px;
    font-weight: 700;
    border 1px solid #f0f0f0;

    &:focus {
        background-color: grey;
    }

    &:focus {
        background-color: #79797945;
    }
`

const SaveBtnText = styled.span`
    display: flex;
    flex-direction: row;
    align-items: center;
    width: 55px;
    justify-content: space-between;
    display: flex;
`

const SaveBtnArrow = styled(Margin)`
    width: 24px;
    border-radius: 3px;

    &:hover {
        background-color: #e0e0e0;
    }
`