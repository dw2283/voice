#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <signal.h>

static BOOL gFnPressed = NO;
static CFMachPortRef gEventTap = NULL;

static void emitMessage(NSDictionary *message) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:message options:0 error:&error];

  if (!data || error) {
    return;
  }

  NSFileHandle *stdoutHandle = [NSFileHandle fileHandleWithStandardOutput];
  [stdoutHandle writeData:data];
  [stdoutHandle writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
}

static void publishStatus(BOOL prompt) {
  NSDictionary *options = @{
    (__bridge NSString *)kAXTrustedCheckOptionPrompt: @(prompt)
  };
  BOOL trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
  NSString *message = trusted
    ? @"Fn hold listener is active."
    : @"Fn hold listener needs Accessibility permission in System Settings > Privacy & Security > Accessibility.";

  emitMessage(@{
    @"event": @"status",
    @"accessibilityTrusted": @(trusted),
    @"message": message,
    @"timestamp": @([[NSDate date] timeIntervalSince1970])
  });
}

static void publishFnPhase(BOOL isDown) {
  if (isDown == gFnPressed) {
    return;
  }

  gFnPressed = isDown;

  emitMessage(@{
    @"event": @"fn",
    @"phase": isDown ? @"down" : @"up",
    @"timestamp": @([[NSDate date] timeIntervalSince1970])
  });
}

static CGEventRef handleEventTap(
  CGEventTapProxy proxy,
  CGEventType type,
  CGEventRef event,
  void *userInfo
) {
  (void)proxy;
  (void)userInfo;

  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (gEventTap != NULL) {
      CGEventTapEnable(gEventTap, true);
    }

    return event;
  }

  if (type != kCGEventFlagsChanged) {
    return event;
  }

  const CGEventFlags flags = CGEventGetFlags(event);
  const BOOL isDown = (flags & kCGEventFlagMaskSecondaryFn) == kCGEventFlagMaskSecondaryFn;
  publishFnPhase(isDown);
  return event;
}

static void handleTerminationSignal(int signalNumber) {
  (void)signalNumber;
  exit(0);
}

int main(void) {
  @autoreleasepool {
    signal(SIGTERM, handleTerminationSignal);
    signal(SIGINT, handleTerminationSignal);

    publishStatus(NO);

    gEventTap = CGEventTapCreate(
      kCGSessionEventTap,
      kCGHeadInsertEventTap,
      kCGEventTapOptionListenOnly,
      CGEventMaskBit(kCGEventFlagsChanged),
      handleEventTap,
      NULL
    );

    if (gEventTap == NULL) {
      emitMessage(@{
        @"event": @"status",
        @"accessibilityTrusted": @NO,
        @"message": @"Fn hold listener could not create a system event tap. Re-enable Accessibility permission for Voice Flow.",
        @"timestamp": @([[NSDate date] timeIntervalSince1970])
      });
      return 1;
    }

    CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, gEventTap, 0);
    CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
    CGEventTapEnable(gEventTap, true);
    CFRunLoopRun();

    if (source != NULL) {
      CFRelease(source);
    }

    if (gEventTap != NULL) {
      CFRelease(gEventTap);
    }
  }

  return 0;
}
