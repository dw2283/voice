#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <signal.h>

static BOOL gHoldTriggered = NO;
static CFMachPortRef gEventTap = NULL;
static BOOL gModifierPressed = NO;
static NSInteger gHoldDelayMs = 0;
static NSString *gHoldKeyName = @"control";
static uint64_t gPressGeneration = 0;

static NSString *normalizeHoldKeyName(NSString *value) {
  NSString *normalized = [[value ?: @"control" lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];

  if ([normalized isEqualToString:@"ctrl"]) {
    return @"control";
  }

  if ([normalized isEqualToString:@"alt"]) {
    return @"option";
  }

  if ([normalized isEqualToString:@"cmd"] || [normalized isEqualToString:@"meta"]) {
    return @"command";
  }

  if ([normalized isEqualToString:@"function"]) {
    return @"fn";
  }

  NSSet<NSString *> *supported = [NSSet setWithArray:@[@"fn", @"control", @"option", @"shift", @"command"]];

  if ([supported containsObject:normalized]) {
    return normalized;
  }

  return @"control";
}

static NSString *holdKeyDisplayName(void) {
  if ([gHoldKeyName isEqualToString:@"fn"]) {
    return @"Fn";
  }

  if ([gHoldKeyName isEqualToString:@"control"]) {
    return @"Control";
  }

  if ([gHoldKeyName isEqualToString:@"option"]) {
    return @"Option";
  }

  if ([gHoldKeyName isEqualToString:@"shift"]) {
    return @"Shift";
  }

  if ([gHoldKeyName isEqualToString:@"command"]) {
    return @"Command";
  }

  return @"Fn";
}

static NSString *holdListenerPrefix(void) {
  return [NSString stringWithFormat:@"%@ hold listener", holdKeyDisplayName()];
}

static CGEventFlags holdKeyMask(void) {
  if ([gHoldKeyName isEqualToString:@"control"]) {
    return kCGEventFlagMaskControl;
  }

  if ([gHoldKeyName isEqualToString:@"option"]) {
    return kCGEventFlagMaskAlternate;
  }

  if ([gHoldKeyName isEqualToString:@"shift"]) {
    return kCGEventFlagMaskShift;
  }

  if ([gHoldKeyName isEqualToString:@"command"]) {
    return kCGEventFlagMaskCommand;
  }

  return kCGEventFlagMaskSecondaryFn;
}

static BOOL isHoldKeyDown(CGEventFlags flags) {
  const CGEventFlags mask = holdKeyMask();
  return (flags & mask) == mask;
}

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
    ? [NSString stringWithFormat:@"%@ is active.", holdListenerPrefix()]
    : [NSString stringWithFormat:@"%@ needs Accessibility permission in System Settings > Privacy & Security > Accessibility.", holdListenerPrefix()];

  emitMessage(@{
    @"event": @"status",
    @"accessibilityTrusted": @(trusted),
    @"holdKey": gHoldKeyName,
    @"message": message,
    @"timestamp": @([[NSDate date] timeIntervalSince1970])
  });
}

static void publishHoldPhase(BOOL isDown) {
  if (isDown == gHoldTriggered) {
    return;
  }

  gHoldTriggered = isDown;

  emitMessage(@{
    @"event": @"hold",
    @"holdKey": gHoldKeyName,
    @"phase": isDown ? @"down" : @"up",
    @"timestamp": @([[NSDate date] timeIntervalSince1970])
  });
}

static void handleHoldKeyTransition(BOOL isDown) {
  if (isDown == gModifierPressed) {
    return;
  }

  gModifierPressed = isDown;
  gPressGeneration += 1;
  const uint64_t generation = gPressGeneration;

  if (isDown) {
    if (gHoldDelayMs <= 0) {
      publishHoldPhase(YES);
      return;
    }

    dispatch_after(
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)gHoldDelayMs * NSEC_PER_MSEC),
      dispatch_get_main_queue(),
      ^{
        if (!gModifierPressed || gPressGeneration != generation || gHoldTriggered) {
          return;
        }

        publishHoldPhase(YES);
      }
    );
    return;
  }

  if (gHoldTriggered) {
    publishHoldPhase(NO);
  }
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
  handleHoldKeyTransition(isHoldKeyDown(flags));
  return event;
}

static void handleTerminationSignal(int signalNumber) {
  (void)signalNumber;
  exit(0);
}

static void configureFromArguments(int argc, const char *argv[]) {
  NSString *holdKey = @"control";
  NSNumber *holdDelayOverride = nil;

  for (int index = 1; index < argc; index += 1) {
    NSString *argument = [NSString stringWithUTF8String:argv[index]];

    if ([argument isEqualToString:@"--hold-key"] && index + 1 < argc) {
      holdKey = [NSString stringWithUTF8String:argv[index + 1]];
      index += 1;
      continue;
    }

    if ([argument isEqualToString:@"--hold-delay-ms"] && index + 1 < argc) {
      holdDelayOverride = @([[NSString stringWithUTF8String:argv[index + 1]] integerValue]);
      index += 1;
    }
  }

  gHoldKeyName = normalizeHoldKeyName(holdKey);

  if (holdDelayOverride != nil) {
    gHoldDelayMs = MAX(0, [holdDelayOverride integerValue]);
    return;
  }

  gHoldDelayMs = [gHoldKeyName isEqualToString:@"fn"] ? 0 : 180;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    signal(SIGTERM, handleTerminationSignal);
    signal(SIGINT, handleTerminationSignal);
    configureFromArguments(argc, argv);

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
        @"holdKey": gHoldKeyName,
        @"message": [NSString stringWithFormat:@"%@ could not create a system event tap. Re-enable Accessibility permission for Voice Flow.", holdListenerPrefix()],
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
