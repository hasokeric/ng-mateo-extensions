import { AnimationEvent } from '@angular/animations';
import { AriaDescriber, FocusMonitor } from '@angular/cdk/a11y';
import { Directionality } from '@angular/cdk/bidi';
import { BooleanInput, coerceBooleanProperty, NumberInput } from '@angular/cdk/coercion';
import { ESCAPE, hasModifierKey } from '@angular/cdk/keycodes';
import { BreakpointObserver, Breakpoints, BreakpointState } from '@angular/cdk/layout';
import {
  FlexibleConnectedPositionStrategy,
  HorizontalConnectionPos,
  OriginConnectionPosition,
  Overlay,
  OverlayConnectionPosition,
  OverlayRef,
  ScrollStrategy,
  VerticalConnectionPos,
} from '@angular/cdk/overlay';
import { Platform, normalizePassiveListenerOptions } from '@angular/cdk/platform';
import { ComponentPortal } from '@angular/cdk/portal';
import { ScrollDispatcher } from '@angular/cdk/scrolling';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Directive,
  ElementRef,
  Inject,
  InjectionToken,
  Input,
  NgZone,
  OnDestroy,
  Optional,
  ViewContainerRef,
  ViewEncapsulation,
  AfterViewInit,
  TemplateRef,
} from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { take, takeUntil } from 'rxjs/operators';

import { mtxTooltipAnimations } from './tooltip-animations';

/** Possible positions for a tooltip. */
export type TooltipPosition = 'left' | 'right' | 'above' | 'below' | 'before' | 'after';

/**
 * Options for how the tooltip trigger should handle touch gestures.
 * See `MtxTooltip.touchGestures` for more information.
 */
export type TooltipTouchGestures = 'auto' | 'on' | 'off';

/** Possible visibility states of a tooltip. */
export type TooltipVisibility = 'initial' | 'visible' | 'hidden';

/** Time in ms to throttle repositioning after scroll events. */
export const SCROLL_THROTTLE_MS = 20;

/** CSS class that will be attached to the overlay panel. */
export const TOOLTIP_PANEL_CLASS = 'mtx-tooltip-panel';

/** Options used to bind passive event listeners. */
const passiveListenerOptions = normalizePassiveListenerOptions({ passive: true });

/**
 * Time between the user putting the pointer on a tooltip
 * trigger and the long press event being fired.
 */
const LONGPRESS_DELAY = 500;

/**
 * Creates an error to be thrown if the user supplied an invalid tooltip position.
 * @docs-private
 */
export function getMtxTooltipInvalidPositionError(position: string) {
  return Error(`Tooltip position "${position}" is invalid.`);
}

/** Injection token that determines the scroll handling while a tooltip is visible. */
export const MTX_TOOLTIP_SCROLL_STRATEGY = new InjectionToken<() => ScrollStrategy>(
  'mtx-tooltip-scroll-strategy'
);

/** @docs-private */
export function MTX_TOOLTIP_SCROLL_STRATEGY_FACTORY(overlay: Overlay): () => ScrollStrategy {
  return () => overlay.scrollStrategies.reposition({ scrollThrottle: SCROLL_THROTTLE_MS });
}

/** @docs-private */
export const MTX_TOOLTIP_SCROLL_STRATEGY_FACTORY_PROVIDER = {
  provide: MTX_TOOLTIP_SCROLL_STRATEGY,
  deps: [Overlay],
  useFactory: MTX_TOOLTIP_SCROLL_STRATEGY_FACTORY,
};

/** Default `mtxTooltip` options that can be overridden. */
export interface MtxTooltipDefaultOptions {
  showDelay: number;
  hideDelay: number;
  touchendHideDelay: number;
  touchGestures?: TooltipTouchGestures;
  position?: TooltipPosition;
}

/** Injection token to be used to override the default options for `matTooltip`. */
export const MTX_TOOLTIP_DEFAULT_OPTIONS = new InjectionToken<MtxTooltipDefaultOptions>(
  'mtx-tooltip-default-options',
  {
    providedIn: 'root',
    factory: MTX_TOOLTIP_DEFAULT_OPTIONS_FACTORY,
  }
);

/** @docs-private */
export function MTX_TOOLTIP_DEFAULT_OPTIONS_FACTORY(): MtxTooltipDefaultOptions {
  return {
    showDelay: 0,
    hideDelay: 0,
    touchendHideDelay: 1500,
  };
}

/**
 * Directive that attaches a material design tooltip to the host element. Animates the showing and
 * hiding of a tooltip provided position (defaults to below the element).
 *
 * https://material.io/design/components/tooltips.html
 */
@Directive({
  selector: '[mtxTooltip]',
  exportAs: 'mtxTooltip',
  host: {
    class: 'mtx-tooltip-trigger',
  },
})
export class MtxTooltip implements OnDestroy, AfterViewInit {
  _overlayRef!: OverlayRef | null;
  _tooltipInstance!: TooltipComponent | null;

  private _portal!: ComponentPortal<TooltipComponent>;
  private _position: TooltipPosition = 'below';
  private _disabled: boolean = false;
  private _tooltipClass!: string | string[] | Set<string> | { [key: string]: any };
  private _scrollStrategy: () => ScrollStrategy;
  private _viewInitialized = false;
  private _pointerExitEventsInitialized = false;

  /** Allows the user to define the position of the tooltip relative to the parent element */
  @Input('mtxTooltipPosition')
  get position(): TooltipPosition {
    return this._position;
  }
  set position(value: TooltipPosition) {
    if (value !== this._position) {
      this._position = value;

      if (this._overlayRef) {
        this._updatePosition();

        if (this._tooltipInstance) {
          this._tooltipInstance!.show(0);
        }

        this._overlayRef.updatePosition();
      }
    }
  }

  /** Disables the display of the tooltip. */
  @Input('mtxTooltipDisabled')
  get disabled(): boolean {
    return this._disabled;
  }
  set disabled(value) {
    this._disabled = coerceBooleanProperty(value);

    // If tooltip is disabled, hide immediately.
    if (this._disabled) {
      this.hide(0);
    } else {
      this._setupPointerEnterEventsIfNeeded();
    }
  }

  /** The default delay in ms before showing the tooltip after show is called */
  @Input('mtxTooltipShowDelay') showDelay: number = this._defaultOptions.showDelay;

  /** The default delay in ms before hiding the tooltip after hide is called */
  @Input('mtxTooltipHideDelay') hideDelay: number = this._defaultOptions.hideDelay;

  /**
   * How touch gestures should be handled by the tooltip. On touch devices the tooltip directive
   * uses a long press gesture to show and hide, however it can conflict with the native browser
   * gestures. To work around the conflict, Angular Material disables native gestures on the
   * trigger, but that might not be desirable on particular elements (e.g. inputs and draggable
   * elements). The different values for this option configure the touch event handling as follows:
   * - `auto` - Enables touch gestures for all elements, but tries to avoid conflicts with native
   *   browser gestures on particular elements. In particular, it allows text selection on inputs
   *   and textareas, and preserves the native browser dragging on elements marked as `draggable`.
   * - `on` - Enables touch gestures for all elements and disables native
   *   browser gestures with no exceptions.
   * - `off` - Disables touch gestures. Note that this will prevent the tooltip from
   *   showing on touch devices.
   */
  @Input('mtxTooltipTouchGestures') touchGestures: TooltipTouchGestures = 'auto';

  /** The message to be displayed in the tooltip */
  @Input('mtxTooltip')
  get message() {
    return this._message;
  }
  set message(value: string | TemplateRef<any>) {
    this._ariaDescriber.removeDescription(this._elementRef.nativeElement, this._message as string);

    // TODO: If the message is a TemplateRef, it's hard to support a11y.
    // If the message is not a string (e.g. number), convert it to a string and trim it.
    this._message = value instanceof TemplateRef ? value : value != null ? `${value}`.trim() : '';

    if (!this._message && this._isTooltipVisible()) {
      this.hide(0);
    } else {
      this._setupPointerEnterEventsIfNeeded();
      this._updateTooltipMessage();
      this._ngZone.runOutsideAngular(() => {
        // The `AriaDescriber` has some functionality that avoids adding a description if it's the
        // same as the `aria-label` of an element, however we can't know whether the tooltip trigger
        // has a data-bound `aria-label` or when it'll be set for the first time. We can avoid the
        // issue by deferring the description by a tick so Angular has time to set the `aria-label`.
        Promise.resolve().then(() => {
          this._ariaDescriber.describe(this._elementRef.nativeElement, this.message as string);
        });
      });
    }
  }
  private _message: string | TemplateRef<any> = '';

  /** Classes to be passed to the tooltip. Supports the same syntax as `ngClass`. */
  @Input('mtxTooltipClass')
  get tooltipClass() {
    return this._tooltipClass;
  }
  set tooltipClass(value: string | string[] | Set<string> | { [key: string]: any }) {
    this._tooltipClass = value;
    if (this._tooltipInstance) {
      this._setTooltipClass(this._tooltipClass);
    }
  }

  /** Manually-bound passive event listeners. */
  private readonly _passiveListeners: (readonly [string, EventListenerOrEventListenerObject])[] =
    [];

  /** Timer started at the last `touchstart` event. */
  private _touchstartTimeout!: number;

  /** Emits when the component is destroyed. */
  private readonly _destroyed = new Subject<void>();

  constructor(
    private _overlay: Overlay,
    private _elementRef: ElementRef<HTMLElement>,
    private _scrollDispatcher: ScrollDispatcher,
    private _viewContainerRef: ViewContainerRef,
    private _ngZone: NgZone,
    private _platform: Platform,
    private _ariaDescriber: AriaDescriber,
    private _focusMonitor: FocusMonitor,
    @Inject(MTX_TOOLTIP_SCROLL_STRATEGY) scrollStrategy: any,
    @Optional() private _dir: Directionality,
    @Optional()
    @Inject(MTX_TOOLTIP_DEFAULT_OPTIONS)
    private _defaultOptions: MtxTooltipDefaultOptions
  ) {
    this._scrollStrategy = scrollStrategy;

    if (_defaultOptions) {
      if (_defaultOptions.position) {
        this.position = _defaultOptions.position;
      }

      if (_defaultOptions.touchGestures) {
        this.touchGestures = _defaultOptions.touchGestures;
      }
    }

    _ngZone.runOutsideAngular(() => {
      _elementRef.nativeElement.addEventListener('keydown', this._handleKeydown);
    });
  }

  ngAfterViewInit() {
    // This needs to happen after view init so the initial values for all inputs have been set.
    this._viewInitialized = true;
    this._setupPointerEnterEventsIfNeeded();

    this._focusMonitor
      .monitor(this._elementRef)
      .pipe(takeUntil(this._destroyed))
      .subscribe(origin => {
        // Note that the focus monitor runs outside the Angular zone.
        if (!origin) {
          this._ngZone.run(() => this.hide(0));
        } else if (origin === 'keyboard') {
          this._ngZone.run(() => this.show());
        }
      });
  }

  /**
   * Dispose the tooltip when destroyed.
   */
  ngOnDestroy() {
    const nativeElement = this._elementRef.nativeElement;

    clearTimeout(this._touchstartTimeout);

    if (this._overlayRef) {
      this._overlayRef.dispose();
      this._tooltipInstance = null;
    }

    // Clean up the event listeners set in the constructor
    nativeElement.removeEventListener('keydown', this._handleKeydown);
    this._passiveListeners.forEach(([event, listener]) => {
      nativeElement.removeEventListener(event, listener, passiveListenerOptions);
    });
    this._passiveListeners.length = 0;

    this._destroyed.next();
    this._destroyed.complete();

    this._ariaDescriber.removeDescription(nativeElement, this.message as string);
    this._focusMonitor.stopMonitoring(nativeElement);
  }

  /** Shows the tooltip after the delay in ms, defaults to tooltip-delay-show or 0ms if no input */
  show(delay: number = this.showDelay): void {
    if (
      this.disabled ||
      !this.message ||
      (this._isTooltipVisible() &&
        !this._tooltipInstance!._showTimeoutId &&
        !this._tooltipInstance!._hideTimeoutId)
    ) {
      return;
    }

    const overlayRef = this._createOverlay();
    this._detach();
    this._portal = this._portal || new ComponentPortal(TooltipComponent, this._viewContainerRef);
    this._tooltipInstance = overlayRef.attach(this._portal).instance;
    this._tooltipInstance
      .afterHidden()
      .pipe(takeUntil(this._destroyed))
      .subscribe(() => this._detach());
    this._setTooltipClass(this._tooltipClass);
    this._updateTooltipMessage();
    this._tooltipInstance!.show(delay);
  }

  /** Hides the tooltip after the delay in ms, defaults to tooltip-delay-hide or 0ms if no input */
  hide(delay: number = this.hideDelay): void {
    if (this._tooltipInstance) {
      this._tooltipInstance.hide(delay);
    }
  }

  /** Shows/hides the tooltip */
  toggle(): void {
    this._isTooltipVisible() ? this.hide() : this.show();
  }

  /** Returns true if the tooltip is currently visible to the user */
  _isTooltipVisible(): boolean {
    return !!this._tooltipInstance && this._tooltipInstance.isVisible();
  }

  /**
   * Handles the keydown events on the host element.
   * Needs to be an arrow function so that we can use it in addEventListener.
   */
  private _handleKeydown = (event: KeyboardEvent) => {
    if (this._isTooltipVisible() && event.keyCode === ESCAPE && !hasModifierKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      this._ngZone.run(() => this.hide(0));
    }
  };

  /** Create the overlay config and position strategy */
  private _createOverlay(): OverlayRef {
    if (this._overlayRef) {
      return this._overlayRef;
    }

    const scrollableAncestors = this._scrollDispatcher.getAncestorScrollContainers(
      this._elementRef
    );

    // Create connected position strategy that listens for scroll events to reposition.
    const strategy = this._overlay
      .position()
      .flexibleConnectedTo(this._elementRef)
      .withTransformOriginOn('.mtx-tooltip')
      .withFlexibleDimensions(false)
      .withViewportMargin(8)
      .withScrollableContainers(scrollableAncestors);

    strategy.positionChanges.pipe(takeUntil(this._destroyed)).subscribe(change => {
      if (this._tooltipInstance) {
        if (change.scrollableViewProperties.isOverlayClipped && this._tooltipInstance.isVisible()) {
          // After position changes occur and the overlay is clipped by
          // a parent scrollable then close the tooltip.
          this._ngZone.run(() => this.hide(0));
        }
      }
    });

    this._overlayRef = this._overlay.create({
      direction: this._dir,
      positionStrategy: strategy,
      panelClass: TOOLTIP_PANEL_CLASS,
      scrollStrategy: this._scrollStrategy(),
    });

    this._updatePosition();

    this._overlayRef
      .detachments()
      .pipe(takeUntil(this._destroyed))
      .subscribe(() => this._detach());

    return this._overlayRef;
  }

  /** Detaches the currently-attached tooltip. */
  private _detach() {
    if (this._overlayRef && this._overlayRef.hasAttached()) {
      this._overlayRef.detach();
    }

    this._tooltipInstance = null;
  }

  /** Updates the position of the current tooltip. */
  private _updatePosition() {
    const position = this._overlayRef!.getConfig()
      .positionStrategy as FlexibleConnectedPositionStrategy;
    const origin = this._getOrigin();
    const overlay = this._getOverlayPosition();

    position.withPositions([
      { ...origin.main, ...overlay.main },
      { ...origin.fallback, ...overlay.fallback },
    ]);
  }

  /**
   * Returns the origin position and a fallback position based on the user's position preference.
   * The fallback position is the inverse of the origin (e.g. `'below' -> 'above'`).
   */
  _getOrigin(): { main: OriginConnectionPosition; fallback: OriginConnectionPosition } {
    const isLtr = !this._dir || this._dir.value === 'ltr';
    const position = this.position;
    let originPosition: OriginConnectionPosition;

    if (position === 'above' || position === 'below') {
      originPosition = { originX: 'center', originY: position === 'above' ? 'top' : 'bottom' };
    } else if (
      position === 'before' ||
      (position === 'left' && isLtr) ||
      (position === 'right' && !isLtr)
    ) {
      originPosition = { originX: 'start', originY: 'center' };
    } else if (
      position === 'after' ||
      (position === 'right' && isLtr) ||
      (position === 'left' && !isLtr)
    ) {
      originPosition = { originX: 'end', originY: 'center' };
    } else {
      throw getMtxTooltipInvalidPositionError(position);
    }

    const { x, y } = this._invertPosition(originPosition.originX, originPosition.originY);

    return {
      main: originPosition,
      fallback: { originX: x, originY: y },
    };
  }

  /** Returns the overlay position and a fallback position based on the user's preference */
  _getOverlayPosition(): { main: OverlayConnectionPosition; fallback: OverlayConnectionPosition } {
    const isLtr = !this._dir || this._dir.value === 'ltr';
    const position = this.position;
    let overlayPosition: OverlayConnectionPosition;

    if (position === 'above') {
      overlayPosition = { overlayX: 'center', overlayY: 'bottom' };
    } else if (position === 'below') {
      overlayPosition = { overlayX: 'center', overlayY: 'top' };
    } else if (
      position === 'before' ||
      (position === 'left' && isLtr) ||
      (position === 'right' && !isLtr)
    ) {
      overlayPosition = { overlayX: 'end', overlayY: 'center' };
    } else if (
      position === 'after' ||
      (position === 'right' && isLtr) ||
      (position === 'left' && !isLtr)
    ) {
      overlayPosition = { overlayX: 'start', overlayY: 'center' };
    } else {
      throw getMtxTooltipInvalidPositionError(position);
    }

    const { x, y } = this._invertPosition(overlayPosition.overlayX, overlayPosition.overlayY);

    return {
      main: overlayPosition,
      fallback: { overlayX: x, overlayY: y },
    };
  }

  /** Updates the tooltip message and repositions the overlay according to the new message length */
  private _updateTooltipMessage() {
    // Must wait for the message to be painted to the tooltip so that the overlay can properly
    // calculate the correct positioning based on the size of the text.
    if (this._tooltipInstance) {
      this._tooltipInstance.message = this.message;
      this._tooltipInstance._markForCheck();

      this._ngZone.onMicrotaskEmpty
        .asObservable()
        .pipe(take(1), takeUntil(this._destroyed))
        .subscribe(() => {
          if (this._tooltipInstance) {
            this._overlayRef!.updatePosition();
          }
        });
    }
  }

  /** Updates the tooltip class */
  private _setTooltipClass(tooltipClass: string | string[] | Set<string> | { [key: string]: any }) {
    if (this._tooltipInstance) {
      this._tooltipInstance.tooltipClass = tooltipClass;
      this._tooltipInstance._markForCheck();
    }
  }

  /** Inverts an overlay position. */
  private _invertPosition(x: HorizontalConnectionPos, y: VerticalConnectionPos) {
    if (this.position === 'above' || this.position === 'below') {
      if (y === 'top') {
        y = 'bottom';
      } else if (y === 'bottom') {
        y = 'top';
      }
    } else {
      if (x === 'end') {
        x = 'start';
      } else if (x === 'start') {
        x = 'end';
      }
    }

    return { x, y };
  }

  /** Binds the pointer events to the tooltip trigger. */
  private _setupPointerEnterEventsIfNeeded() {
    // Optimization: Defer hooking up events if there's no message or the tooltip is disabled.
    if (
      this._disabled ||
      !this.message ||
      !this._viewInitialized ||
      this._passiveListeners.length
    ) {
      return;
    }

    // The mouse events shouldn't be bound on mobile devices, because they can prevent the
    // first tap from firing its click event or can cause the tooltip to open for clicks.
    if (this._platformSupportsMouseEvents()) {
      this._passiveListeners.push([
        'mouseenter',
        () => {
          this._setupPointerExitEventsIfNeeded();
          this.show();
        },
      ]);
    } else if (this.touchGestures !== 'off') {
      this._disableNativeGesturesIfNecessary();

      this._passiveListeners.push([
        'touchstart',
        () => {
          // Note that it's important that we don't `preventDefault` here,
          // because it can prevent click events from firing on the element.
          this._setupPointerExitEventsIfNeeded();
          clearTimeout(this._touchstartTimeout);
          this._touchstartTimeout = setTimeout(() => this.show(), LONGPRESS_DELAY) as any;
        },
      ]);
    }

    this._addListeners(this._passiveListeners);
  }

  private _setupPointerExitEventsIfNeeded() {
    if (this._pointerExitEventsInitialized) {
      return;
    }
    this._pointerExitEventsInitialized = true;

    const exitListeners: (readonly [string, EventListenerOrEventListenerObject])[] = [];
    if (this._platformSupportsMouseEvents()) {
      exitListeners.push(['mouseleave', () => this.hide()]);
    } else if (this.touchGestures !== 'off') {
      this._disableNativeGesturesIfNecessary();
      const touchendListener = () => {
        clearTimeout(this._touchstartTimeout);
        this.hide(this._defaultOptions.touchendHideDelay);
      };

      exitListeners.push(['touchend', touchendListener], ['touchcancel', touchendListener]);
    }

    this._addListeners(exitListeners);
    this._passiveListeners.push(...exitListeners);
  }

  private _addListeners(
    listeners: ReadonlyArray<readonly [string, EventListenerOrEventListenerObject]>
  ) {
    listeners.forEach(([event, listener]) => {
      this._elementRef.nativeElement.addEventListener(event, listener, passiveListenerOptions);
    });
  }

  private _platformSupportsMouseEvents() {
    return !this._platform.IOS && !this._platform.ANDROID;
  }

  /** Disables the native browser gestures, based on how the tooltip has been configured. */
  private _disableNativeGesturesIfNecessary() {
    const gestures = this.touchGestures;

    if (gestures !== 'off') {
      const element = this._elementRef.nativeElement;
      const style = element.style;

      // If gestures are set to `auto`, we don't disable text selection on inputs and
      // textareas, because it prevents the user from typing into them on iOS Safari.
      if (gestures === 'on' || (element.nodeName !== 'INPUT' && element.nodeName !== 'TEXTAREA')) {
        style.userSelect =
          (style as any).msUserSelect =
          style.webkitUserSelect =
          (style as any).MozUserSelect =
            'none';
      }

      // If we have `auto` gestures and the element uses native HTML dragging,
      // we don't set `-webkit-user-drag` because it prevents the native behavior.
      if (gestures === 'on' || !element.draggable) {
        (style as any).webkitUserDrag = 'none';
      }

      style.touchAction = 'none';
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      style.webkitTapHighlightColor = 'transparent';
    }
  }

  static ngAcceptInputType_disabled: BooleanInput;
  static ngAcceptInputType_hideDelay: NumberInput;
  static ngAcceptInputType_showDelay: NumberInput;
}

/**
 * Internal component that wraps the tooltip's content.
 * @docs-private
 */
@Component({
  selector: 'mtx-tooltip-component',
  templateUrl: 'tooltip.html',
  styleUrls: ['tooltip.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [mtxTooltipAnimations.tooltipState],
  host: {
    // Forces the element to have a layout in IE and Edge. This fixes issues where the element
    // won't be rendered if the animations are disabled or there is no web animations polyfill.
    '[style.zoom]': '_visibility === "visible" ? 1 : null',
    '(body:click)': 'this._handleBodyInteraction()',
    'aria-hidden': 'true',
  },
})
export class TooltipComponent implements OnDestroy {
  /** Message to display in the tooltip */
  message!: string | TemplateRef<any>;

  /** Classes to be added to the tooltip. Supports the same syntax as `ngClass`. */
  tooltipClass!: string | string[] | Set<string> | { [key: string]: any };

  /** The timeout ID of any current timer set to show the tooltip */
  _showTimeoutId!: number | null;

  /** The timeout ID of any current timer set to hide the tooltip */
  _hideTimeoutId!: number | null;

  /** Property watched by the animation framework to show or hide the tooltip */
  _visibility: TooltipVisibility = 'initial';

  /** Whether interactions on the page should close the tooltip */
  private _closeOnInteraction: boolean = false;

  /** Subject for notifying that the tooltip has been hidden from the view */
  private readonly _onHide: Subject<void> = new Subject();

  /** Stream that emits whether the user has a handset-sized display.  */
  _isHandset: Observable<BreakpointState> = this._breakpointObserver.observe(Breakpoints.Handset);

  _isTemplateRef(obj: any) {
    return obj instanceof TemplateRef;
  }

  constructor(
    private _changeDetectorRef: ChangeDetectorRef,
    private _breakpointObserver: BreakpointObserver
  ) {}

  /**
   * Shows the tooltip with an animation originating from the provided origin
   * @param delay Amount of milliseconds to the delay showing the tooltip.
   */
  show(delay: number): void {
    // Cancel the delayed hide if it is scheduled
    if (this._hideTimeoutId) {
      clearTimeout(this._hideTimeoutId);
      this._hideTimeoutId = null;
    }

    // Body interactions should cancel the tooltip if there is a delay in showing.
    this._closeOnInteraction = true;
    this._showTimeoutId = setTimeout(() => {
      this._visibility = 'visible';
      this._showTimeoutId = null;

      // Mark for check so if any parent component has set the
      // ChangeDetectionStrategy to OnPush it will be checked anyways
      this._markForCheck();
    }, delay) as any;
  }

  /**
   * Begins the animation to hide the tooltip after the provided delay in ms.
   * @param delay Amount of milliseconds to delay showing the tooltip.
   */
  hide(delay: number): void {
    // Cancel the delayed show if it is scheduled
    if (this._showTimeoutId) {
      clearTimeout(this._showTimeoutId);
      this._showTimeoutId = null;
    }

    this._hideTimeoutId = setTimeout(() => {
      this._visibility = 'hidden';
      this._hideTimeoutId = null;

      // Mark for check so if any parent component has set the
      // ChangeDetectionStrategy to OnPush it will be checked anyways
      this._markForCheck();
    }, delay) as any;
  }

  /** Returns an observable that notifies when the tooltip has been hidden from view. */
  afterHidden(): Observable<void> {
    return this._onHide.asObservable();
  }

  /** Whether the tooltip is being displayed. */
  isVisible(): boolean {
    return this._visibility === 'visible';
  }

  ngOnDestroy() {
    this._onHide.complete();
  }

  _animationStart() {
    this._closeOnInteraction = false;
  }

  _animationDone(event: AnimationEvent): void {
    const toState = event.toState as TooltipVisibility;

    if (toState === 'hidden' && !this.isVisible()) {
      this._onHide.next();
    }

    if (toState === 'visible' || toState === 'hidden') {
      this._closeOnInteraction = true;
    }
  }

  /**
   * Interactions on the HTML body should close the tooltip immediately as defined in the
   * material design spec.
   * https://material.io/design/components/tooltips.html#behavior
   */
  _handleBodyInteraction(): void {
    if (this._closeOnInteraction) {
      this.hide(0);
    }
  }

  /**
   * Marks that the tooltip needs to be checked in the next change detection run.
   * Mainly used for rendering the initial text before positioning a tooltip, which
   * can be problematic in components with OnPush change detection.
   */
  _markForCheck(): void {
    this._changeDetectorRef.markForCheck();
  }
}
