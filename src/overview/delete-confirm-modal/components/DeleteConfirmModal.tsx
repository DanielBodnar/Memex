import React, { PureComponent } from 'react'
import { PrimaryAction } from 'src/common-ui/components/design-library/actions/PrimaryAction'
import * as icons from 'src/common-ui/components/design-library/icons'
import { ConfirmModal, ConfirmModalProps } from '../../../common-ui/components'

export interface Props extends ConfirmModalProps {
    deleteDocs: () => Promise<void>
    submessage?: string
}

class DeleteConfirmModal extends PureComponent<Props> {
    private _action: React.RefObject<HTMLButtonElement>

    constructor(props) {
        super(props)
        this._action = React.createRef()
    }

    componentDidMount() {
        this._action.current.focus()
    }

    render() {
        const { deleteDocs, ...modalProps } = this.props

        return (
            <ConfirmModal
                {...modalProps}
                message={this.props.message}
                submessage={this.props.submessage}
                type={'alert'}
                icon={icons.trash}
            >
                <PrimaryAction
                    label="Delete"
                    onClick={deleteDocs}
                    innerRef={this._action}
                    tabIndex={0}
                />
            </ConfirmModal>
        )
    }
}

export default DeleteConfirmModal
