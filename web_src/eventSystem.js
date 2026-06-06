// ====================================================================================================================
// class EventSystem
//
// A simple event class that maps an eventId to a set of listeners.
//
// eventId's are unique dictionary keys (generally strings).
// listener's are a self pointer, function pointer and context to be called
//   self.fn(context, eventData)
// defaultData is data that will be passed to a listener if the event provides none.
//
// Typical usage:
//	const eventSystem = new EventSystem();
//	eventSystem.setDefaultData('found.it', true);
//  eventSystem.addListener('found.it', { fn: onFoundCallback, self: this, context: null });
export class EventSystem {
  _events = {};

  // Constructor for an empty event
  static _emptyEvent() {
    return { defaultData: null, listeners: [] };
  }

  constructor({ onAddListener = null, onRemoveListener = null } = {}) {
    this.onAddListener = onAddListener;
    this.onRemoveListener = onRemoveListener;
  }

  // Set the default data that will be passed to a listener if none provided
  setDefaultData(eventId, eventData) {
    this._events[eventId] ??= this.constructor._emptyEvent();
    this._events[eventId].defaultData = eventData;
  }

  // Returns default data set for event or undefined if none
  getDefaultData(eventId) {
    return this._events[eventId]?.defaultData;
  }

  // Add a listener for the specified event
  // Calls onAddListener after listener is added
  addListener(eventId, { fn, self = null, context = null, defaultValue = null } = {}) {
    if (typeof fn == 'function') {
      const event = (this._events[eventId] ??= this.constructor._emptyEvent());

      if (defaultValue) {
        event.defaultValue = defaultValue;
      }

      event.listeners.push({ fn, self, context });

      if (typeof this.onAddListener == 'function') {
        this.onAddListener(eventId, { fn, self, context });
      }
    }
  }

  // Remove the listeners that match criteria. If fn, self, context are null
  // they are not used for match. Thus if all three are null then all listeners
  // are removed.
  // Calls this.onRemoveListener after listeners are removed
  removeListener(eventId, { fn, self = null, context = null } = {}) {
    const event = this._events[eventId];
    if (event) {
      // Split the listener list into listeners to keep and remove
      const keepList = [],
        removeList = [];
      event.listeners.forEach((item) => {
        if (
          (fn == null || item.fn == fn) &&
          (self == null || item.self == self) &&
          (context == null || item.context == self)
        ) {
          removeList.push(item);
          item.fn = () => false;
        } else {
          keepList.push(item);
        }
      });

      event.listeners = keepList;

      // Call the onRemoveListener for all the ones we've removed
      if (typeof this.onRemoveListener == 'function') {
        removeList.forEach((item) => {
          this.onRemoveListener(eventId, item);
        });
      }
    }
  }

  // Removes all listeners and clears the default data for the specified eventId
  // Calls onRemoveListener after each listener is removed
  deleteEvent(eventId) {
    this.removeListener(eventId);
    delete this._events[eventId];
  }

  // Clears all listeners resetting the system completely
  reset() {
    for (const eventId in Object.keys(this._events)) {
      this.deleteEvent(eventId);
    }
  }

  // Returns an array of event ids for which we have listeners
  getEventIds() {
    return Object.keys(this._events);
  }

  // Returns number of listeners for the specified event
  listenerCount(eventId) {
    return this._events[eventId]?.listeners.length ?? 0;
  }

  hasListener(eventId) {
    return this.listenerCount(eventId) != 0;
  }

  // Call all listeners with the data specified or otherwise defaultData.
  //   self.fn(context, eventData)
  // Returns true if any listener was called
  fire(eventId, eventData) {
    const event = this._events[eventId];
    if (event) {
      eventData = eventData ?? event.defaultData;
      const currentListeners = [...event.listeners];
      currentListeners.forEach((listener) => listener.fn.call(listener.self, listener.context, eventData));
      return currentListeners.length != 0;
    }
    return false;
  }
}
