import React from 'react'
import PropTypes from 'prop-types'
import { PrimaryAction } from '@worldbrain/memex-common/lib/common-ui/components/PrimaryAction'
import styled from 'styled-components'

const RemovedText = (props) => {
    return (
        <RemoveContainer>
            You can always enable this feature again via the settings.
            <PrimaryAction onClick={props.undo} fontSize="10px" label="Undo" />
        </RemoveContainer>
    )
}

const RemoveContainer = styled.div`
    box-shadow: 0px 0px 3px rgba(0, 0, 0, 0.1);
    color: ${(props) => props.theme.colors.greyScale5};
    padding: 20px;
    grid-gap: 15px;
    font-size: 14px;
    display: flex;
`

RemovedText.propTypes = {
    undo: PropTypes.func.isRequired,
}

export default RemovedText
