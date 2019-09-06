import React from 'react'
import Debug from 'debug'
import uuid from 'uuid/v4'

import { Handle } from 'hypermerge'
import { ContextMenuTrigger } from 'react-contextmenu'
import { ContentProps } from '../../Content'
import ContentTypes from '../../../ContentTypes'
import * as ImportData from '../../../ImportData'
import { parseDocumentLink, PushpinUrl } from '../../../ShareLink'
import { BoardDoc } from '.'
import BoardCard from './BoardCard'
import BoardContextMenu from './BoardContextMenu'
import './Board.css'
import {
  Position,
  Dimension,
  gridOffset,
  gridCellsToPixels,
  snapDimensionToGrid,
  snapPositionToGrid,
} from './BoardGrid'

const log = Debug('pushpin:board')

export const BOARD_COLORS = {
  DEFAULT: '#D5DFE5',
  SNOW: '#EBEDF4',
  BEIGE: '#f3f1ec',
  CANVAS: '#D8D1C0',
  SKY: '#dcf3f6',
  VIOLET: '#e5dcf6',
  PINK: '#ffe1e7',
  HERB: '#daefd2',
  PEACH: '#ffd2cc',
  RUST: '#D96767',
  ENGINEER: '#FFE283',
  KEYLIME: '#A1E991',
  PINE: '#63D2A5',
  SOFT: '#64BCDF',
  BIGBLUE: '#3A66A3',
  ROYAL: '#A485E2',
  KAWAII: '#ED77AA',
  BLACK: '#2b2b2b',
}

const CARD_MIN_WIDTH = 81
const CARD_MIN_HEIGHT = 41

const BOARD_WIDTH = 3600
const BOARD_HEIGHT = 1800

// We don't want to compute a new array in every render.
const BOARD_COLOR_VALUES = Object.values(BOARD_COLORS)

const draggableCards = (cards, selected, card) => {
  if (selected.length > 0 && selected.find((id) => id === card.id)) {
    return selected.map((id) => cards[id])
  }
  return [card]
}

interface State {
  selected: any[]
  remoteSelection: { [contact: string]: string[] }
  contextMenuPosition?: Position
  doc?: BoardDoc
}

export enum DragType {
  MOVING,
  RESIZING,
  NOT_DRAGGING,
}

export interface MoveTracking {
  dragType: DragType.MOVING
  moveX: number
  moveY: number
  slackX: number
  slackY: number
}

export interface ResizeTracking {
  dragType: DragType.RESIZING
  slackWidth: number
  slackHeight: number
  resizeWidth: number
  resizeHeight: number
  minWidth: number
  minHeight: number
  maxWidth: number
  maxHeight: number
}

export interface NotDraggingTracking {
  dragType: DragType.NOT_DRAGGING
}

export function isMoving(tracking): tracking is MoveTracking {
  return tracking.dragType === DragType.MOVING
}

export function isResizing(tracking): tracking is ResizeTracking {
  return tracking.dragType === DragType.RESIZING
}

export type TrackingEntry = MoveTracking | ResizeTracking | NotDraggingTracking

interface CardArgs {
  position: Position
  dimension?: Dimension
}

export interface AddCardArgs extends CardArgs {
  url: PushpinUrl
}

export default class Board extends React.PureComponent<ContentProps, State> {
  private handle?: Handle<BoardDoc>

  private boardRef = React.createRef<HTMLDivElement>()
  private cardRefs: Map<string, HTMLDivElement> = new Map<string, HTMLDivElement>()

  private heartbeatTimerId?: NodeJS.Timer
  private contactHeartbeatTimerId: Map<string, NodeJS.Timer> = new Map<string, NodeJS.Timer>()

  state: State = {
    remoteSelection: {},
    selected: [],
  }

  componentWillMount = () => {
    this.handle = window.repo.open(this.props.hypermergeUrl)
    this.handle.subscribe((doc) => this.onChange(doc))
    this.handle.subscribeMessage((msg) => this.onMessage(msg))
  }
  componentWillUnmount = () => {
    this.handle && this.handle.close()
    this.heartbeatTimerId && clearInterval(this.heartbeatTimerId)
  }

  onChange = (doc) => {
    this.setState({ doc })
  }

  onKeyDown = (e) => {
    // this event can be consumed by a card if it wants to keep control of backspace
    // for example, see text-content.jsx onKeyDown
    if (e.key === 'Backspace') {
      this.deleteCard(this.state.selected)
    }
  }

  onClick = (e) => {
    log('onClick')
    this.selectNone()
  }

  onCardClicked = (card, e) => {
    if (e.ctrlKey || e.shiftKey) {
      this.selectToggle(card.id)
    } else {
      // otherwise we don't have shift/ctrl, so just set selection to this
      this.selectOnly(card.id)
    }
    e.stopPropagation()
  }

  onCardDoubleClicked = (card, e) => {
    window.location = card.url
    e.stopPropagation()
  }

  onDoubleClick = (e) => {
    log('onDoubleClick')

    // guard against a missing boardRef
    if (!this.boardRef.current) {
      return
    }

    const position = {
      x: e.pageX - this.boardRef.current.offsetLeft,
      y: e.pageY - this.boardRef.current.offsetTop,
    }

    ContentTypes.create('text', { text: '' }, (url) => {
      const cardId = this.addCardForContent({ position, url })
      this.selectOnly(cardId)
    })
  }

  onDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
  }

  onDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const { pageX, pageY } = e

    if (!this.boardRef.current) {
      return
    }
    const position = {
      x: pageX - this.boardRef.current.offsetLeft,
      y: pageY - this.boardRef.current.offsetTop,
    }

    ImportData.importDataTransfer(e.dataTransfer, (url, i) => {
      const offsetPosition = gridOffset(position, i)
      this.addCardForContent({ position: offsetPosition, url })
    })
  }

  onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    log('onPaste')
    e.preventDefault()
    e.stopPropagation()

    if (!e.clipboardData) {
      return
    }

    /* We can't get the mouse position on a paste event,
     so we ask the window for the current pageX/Y offsets and just stick the new card
     100px in from there. (The new React might support this through pointer events.) */
    const position = {
      x: window.pageXOffset + 100,
      y: window.pageYOffset + 100,
    }

    ImportData.importDataTransfer(e.clipboardData, (url, i) => {
      const offsetPosition = gridOffset(position, i)
      this.addCardForContent({ position: offsetPosition, url })
    })
  }

  onFilesOpened = (e: React.FormEvent<HTMLInputElement>) => {
    // e.target.files
  }

  addCardForContent = ({ position, dimension, url }: AddCardArgs) => {
    const id = uuid()

    const { type } = parseDocumentLink(url)
    const { component = {} } = ContentTypes.lookup({ type, context: 'board' }) as any

    if (!dimension)
      dimension = {
        width: gridCellsToPixels(component.defaultWidth),
        height: gridCellsToPixels(component.defaultHeight),
      }

    this.handle &&
      this.handle.change((b) => {
        const { x, y } = snapPositionToGrid(position)
        const { width, height } = snapDimensionToGrid(dimension)
        const newCard = {
          id,
          url,
          x,
          y,
          width,
          height,
        }
        b.cards[id] = newCard
      })

    return id
  }

  deleteCard = (id) => {
    // allow either an array or a single card to be passed in
    if (id.constructor !== Array) {
      id = [id]
    }

    this.handle &&
      this.handle.change((b) => {
        id.forEach((id) => delete b.cards[id])
      })
  }

  changeTitle = (title) => {
    log('changeTitle')
    this.handle &&
      this.handle.change((b) => {
        b.title = title
      })
  }

  changeBackgroundColor = (color) => {
    log('changeBackgroundColor')
    this.handle &&
      this.handle.change((b) => {
        b.backgroundColor = color.hex
      })
  }

  /**
   *
   * Card placement / manipulation actions
   *
   */

  cardMoved = ({ id, position }) => {
    if (!(this.state.doc && this.state.doc.cards)) {
      return
    }

    // This gets called when uniquely selecting a card, so avoid a document
    // change if in fact the card hasn't moved mod snapping.
    const snapPosition = snapPositionToGrid(position)
    const cardPosition = { x: this.state.doc.cards[id].x, y: this.state.doc.cards[id].y }
    if (snapPosition.x === cardPosition.x && snapPosition.y === cardPosition.y) {
      return
    }
    this.handle &&
      this.handle.change((b) => {
        const card = b.cards[id]
        card.x = snapPosition.x
        card.y = snapPosition.y
      })
  }

  cardResized = ({ id, dimension }) => {
    if (!(this.state.doc && this.state.doc.cards)) {
      return
    }

    // This gets called when we click the drag corner of a card, so avoid a
    // document change if in fact the card won't resize mod snapping.
    const snapDimension = snapDimensionToGrid(dimension)
    const cardDimension = {
      width: this.state.doc.cards[id].width,
      height: this.state.doc.cards[id].height,
    }
    if (
      snapDimension.width === cardDimension.width &&
      snapDimension.height === cardDimension.height
    ) {
      return
    }
    this.handle &&
      this.handle.change((b) => {
        const card = b.cards[id]
        card.width = snapDimension.width
        card.height = snapDimension.height
      })
  }

  effectDrag = (card, tracking: TrackingEntry, { deltaX, deltaY }) => {
    if (deltaX === 0 && deltaY === 0) {
      return
    }

    if (isMoving(tracking)) {
      // First guess at change in location given mouse movements.
      const preClampX = tracking.moveX + deltaX
      const preClampY = tracking.moveY + deltaY

      // Add slack to the values used to calculate bound position. This will
      // ensure that if we start removing slack, the element won't react to
      // it right away until it's been completely removed.
      let newX = preClampX + tracking.slackX
      let newY = preClampY + tracking.slackY

      // Clamp to ensure card doesn't move beyond the board.
      newX = Math.max(newX, 0)
      newX = Math.min(newX, BOARD_WIDTH - card.width)
      tracking.moveX = newX
      newY = Math.max(newY, 0)
      newY = Math.min(newY, BOARD_HEIGHT - card.height)
      tracking.moveY = newY

      // If the numbers changed, we must have introduced some slack.
      // Record it for the next iteration.
      tracking.slackX = tracking.slackX + preClampX - newX
      tracking.slackY = tracking.slackY + preClampY - newY
    }

    if (isResizing(tracking)) {
      // First guess at change in dimensions given mouse movements.
      const preClampWidth = tracking.resizeWidth + deltaX
      const preClampHeight = tracking.resizeHeight + deltaY

      if (preClampWidth + card.x > BOARD_WIDTH || preClampHeight + card.y > BOARD_HEIGHT) {
        return
      }

      // Add slack to the values used to calculate bound position. This will
      // ensure that if we start removing slack, the element won't react to
      // it right away until it's been completely removed.
      let newWidth = preClampWidth + tracking.slackWidth
      let newHeight = preClampHeight + tracking.slackHeight

      // Clamp to ensure card doesn't resize beyond the board or min dimensions.
      newWidth = Math.max(tracking.minWidth, newWidth)
      newWidth = Math.min(tracking.maxWidth, newWidth)
      newWidth = Math.min(BOARD_WIDTH - card.x, newWidth)
      tracking.resizeWidth = newWidth
      newHeight = Math.max(tracking.minHeight, newHeight)
      newHeight = Math.min(tracking.maxHeight, newHeight)
      newHeight = Math.min(BOARD_HEIGHT - card.y, newHeight)
      tracking.resizeHeight = newHeight

      // If the numbers changed, we must have introduced some slack.
      // Record it for the next iteration.
      tracking.slackWidth = tracking.slackWidth + preClampWidth - newWidth
      tracking.slackHeight = tracking.slackHeight + preClampHeight - newHeight
    }
  }

  setCardRef = (id, node) => {
    this.cardRefs[id] = node
  }

  onMessage = (msg) => {
    const { contact, selected } = msg

    if (contact && selected) {
      this.setState((prevState) => ({
        remoteSelection: {
          ...prevState.remoteSelection,
          [contact]: selected,
        },
      }))
    }

    // if we don't hear from another user for a while, assume they've gone offline
    if (contact) {
      clearTimeout(this.contactHeartbeatTimerId[contact])
      // if we miss two heartbeats (11s), assume they've gone offline
      this.contactHeartbeatTimerId[contact] = setTimeout(() => {
        this.clearRemoteSelection(contact)
      }, 3000)
    }
  }

  clearRemoteSelection = (contact) => {
    this.setState((prevState) => ({
      remoteSelection: {
        ...prevState.remoteSelection,
        [contact]: undefined,
      },
    }))
  }

  updateSelection = (selected) => {
    this.setState({ selected })
    this.handle && this.handle.message({ contact: this.props.selfId, selected })
  }

  selectToggle = (cardId) => {
    const { selected } = this.state

    if (selected.includes(cardId)) {
      // remove from the current state if we have it
      this.updateSelection([selected.filter((filterId) => filterId !== cardId)])
    } else {
      // add to the current state if we don't
      this.updateSelection([...selected, cardId])
    }
  }

  selectOnly = (cardId) => {
    this.updateSelection([cardId])
  }

  selectNone = () => {
    this.updateSelection([])
  }

  render = () => {
    log('render')
    if (!(this.state.doc && this.state.doc.cards)) {
      return null
    }

    // invert the client->cards to a cards->client mapping
    const { remoteSelection } = this.state
    const cardsSelected = {}
    Object.entries(remoteSelection).forEach(([contact, cards]) => {
      cards &&
        cards.forEach((card) => {
          if (!cardsSelected[card]) {
            cardsSelected[card] = []
          }
          cardsSelected[card].push(contact)
        })
    })

    const cards = this.state.doc.cards || {}
    const cardChildren = Object.entries(cards).map(([id, card]) => {
      const selected = this.state.selected.includes(id)
      const uniquelySelected = selected && this.state.selected.length === 1
      return (
        <BoardCard
          key={id}
          id={id}
          boardUrl={this.props.hypermergeUrl}
          card={card}
          selected={selected}
          remoteSelected={cardsSelected[id] || []}
          uniquelySelected={uniquelySelected}
          onCardClicked={this.onCardClicked}
          onCardDoubleClicked={this.onCardDoubleClicked}
          setCardRef={this.setCardRef}
        />
      )
    })

    return (
      <div
        className="Board"
        ref={this.boardRef}
        style={{
          backgroundColor: this.state.doc.backgroundColor,
          width: BOARD_WIDTH,
          height: BOARD_HEIGHT,
        }}
        onKeyDown={this.onKeyDown}
        onClick={this.onClick}
        onDoubleClick={this.onDoubleClick}
        onDragOver={this.onDragOver}
        onDrop={this.onDrop}
        onPaste={this.onPaste}
        role="presentation"
      >
        <BoardContextMenu
          boardTitle={this.state.doc.title}
          contentTypes={ContentTypes.list({ context: 'board' })}
          addCardForContent={this.addCardForContent}
          backgroundColor={this.state.doc.backgroundColor || BOARD_COLORS.DEFAULT}
          backgroundColors={BOARD_COLOR_VALUES}
          changeBackgroundColor={this.changeBackgroundColor}
        />
        <ContextMenuTrigger holdToDisplay={-1} id="BoardMenu">
          <div>{cardChildren}</div>
        </ContextMenuTrigger>
      </div>
    )
  }
}
