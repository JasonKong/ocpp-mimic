/**
 * OCPP 2.0.1 message definitions: all 64 actions with their datatypes and
 * enumerations, transcribed from the field tables of OCPP 2.0.1 Edition 3,
 * Part 2, "Messages, Datatypes & Enumerations" (names, types, lengths,
 * cardinalities and values). Every class also takes the optional
 * `customData` that Part 4 (OCPP-J) adds to all of them. Nothing here comes
 * from OCA's JSON schemas; a test in the engine cross-checks the two.
 *
 * identifierString is checked for its length only, like the official
 * schemas do, not for its character set.
 */
import {
  anyValue,
  array,
  boolean,
  dateTime,
  integer,
  number,
  object,
  oneOf,
  string,
  validate,
  type Infer,
  type Schema,
  type Shape,
  type ValidationErrorCode,
  type ValidationResult,
} from '../schema.js';

/** CustomDataType (Part 4): vendor-specific data, allowed on every class. */
export const CustomDataSchema = object(
  { vendorId: string({ maxLength: 255 }) },
  {},
  { additionalProperties: true },
);
export type CustomDataType = Infer<typeof CustomDataSchema>;

/** A 2.0.1 class: the fields of its table plus the optional `customData`. */
function cls<R extends Shape, O extends Shape = Record<never, never>>(required: R, optional?: O) {
  return object(required, { ...(optional ?? ({} as O)), customData: CustomDataSchema });
}

// ---- Enumerations (Part 2, chapter 3) ------------------------------------

export const APNAuthenticationEnumSchema = oneOf(['CHAP', 'NONE', 'PAP', 'AUTO']);
export type APNAuthenticationEnumType = Infer<typeof APNAuthenticationEnumSchema>;
export const AttributeEnumSchema = oneOf(['Actual', 'Target', 'MinSet', 'MaxSet']);
export type AttributeEnumType = Infer<typeof AttributeEnumSchema>;
export const AuthorizationStatusEnumSchema = oneOf([
  'Accepted',
  'Blocked',
  'ConcurrentTx',
  'Expired',
  'Invalid',
  'NoCredit',
  'NotAllowedTypeEVSE',
  'NotAtThisLocation',
  'NotAtThisTime',
  'Unknown',
]);
export type AuthorizationStatusEnumType = Infer<typeof AuthorizationStatusEnumSchema>;
export const AuthorizeCertificateStatusEnumSchema = oneOf([
  'Accepted',
  'SignatureError',
  'CertificateExpired',
  'CertificateRevoked',
  'NoCertificateAvailable',
  'CertChainError',
  'ContractCancelled',
]);
export type AuthorizeCertificateStatusEnumType = Infer<typeof AuthorizeCertificateStatusEnumSchema>;
export const BootReasonEnumSchema = oneOf([
  'ApplicationReset',
  'FirmwareUpdate',
  'LocalReset',
  'PowerUp',
  'RemoteReset',
  'ScheduledReset',
  'Triggered',
  'Unknown',
  'Watchdog',
]);
export type BootReasonEnumType = Infer<typeof BootReasonEnumSchema>;
export const CancelReservationStatusEnumSchema = oneOf(['Accepted', 'Rejected']);
export type CancelReservationStatusEnumType = Infer<typeof CancelReservationStatusEnumSchema>;
export const CertificateActionEnumSchema = oneOf(['Install', 'Update']);
export type CertificateActionEnumType = Infer<typeof CertificateActionEnumSchema>;
export const CertificateSignedStatusEnumSchema = oneOf(['Accepted', 'Rejected']);
export type CertificateSignedStatusEnumType = Infer<typeof CertificateSignedStatusEnumSchema>;
export const CertificateSigningUseEnumSchema = oneOf([
  'ChargingStationCertificate',
  'V2GCertificate',
]);
export type CertificateSigningUseEnumType = Infer<typeof CertificateSigningUseEnumSchema>;
export const ChangeAvailabilityStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'Scheduled']);
export type ChangeAvailabilityStatusEnumType = Infer<typeof ChangeAvailabilityStatusEnumSchema>;
export const ChargingLimitSourceEnumSchema = oneOf(['EMS', 'Other', 'SO', 'CSO']);
export type ChargingLimitSourceEnumType = Infer<typeof ChargingLimitSourceEnumSchema>;
export const ChargingProfileKindEnumSchema = oneOf(['Absolute', 'Recurring', 'Relative']);
export type ChargingProfileKindEnumType = Infer<typeof ChargingProfileKindEnumSchema>;
export const ChargingProfilePurposeEnumSchema = oneOf([
  'ChargingStationExternalConstraints',
  'ChargingStationMaxProfile',
  'TxDefaultProfile',
  'TxProfile',
]);
export type ChargingProfilePurposeEnumType = Infer<typeof ChargingProfilePurposeEnumSchema>;
export const ChargingProfileStatusEnumSchema = oneOf(['Accepted', 'Rejected']);
export type ChargingProfileStatusEnumType = Infer<typeof ChargingProfileStatusEnumSchema>;
export const ChargingRateUnitEnumSchema = oneOf(['W', 'A']);
export type ChargingRateUnitEnumType = Infer<typeof ChargingRateUnitEnumSchema>;
export const ChargingStateEnumSchema = oneOf([
  'Charging',
  'EVConnected',
  'SuspendedEV',
  'SuspendedEVSE',
  'Idle',
]);
export type ChargingStateEnumType = Infer<typeof ChargingStateEnumSchema>;
export const ClearCacheStatusEnumSchema = oneOf(['Accepted', 'Rejected']);
export type ClearCacheStatusEnumType = Infer<typeof ClearCacheStatusEnumSchema>;
export const ClearChargingProfileStatusEnumSchema = oneOf(['Accepted', 'Unknown']);
export type ClearChargingProfileStatusEnumType = Infer<typeof ClearChargingProfileStatusEnumSchema>;
export const ClearMessageStatusEnumSchema = oneOf(['Accepted', 'Unknown']);
export type ClearMessageStatusEnumType = Infer<typeof ClearMessageStatusEnumSchema>;
export const ClearMonitoringStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'NotFound']);
export type ClearMonitoringStatusEnumType = Infer<typeof ClearMonitoringStatusEnumSchema>;
export const ComponentCriterionEnumSchema = oneOf(['Active', 'Available', 'Enabled', 'Problem']);
export type ComponentCriterionEnumType = Infer<typeof ComponentCriterionEnumSchema>;
export const ConnectorEnumSchema = oneOf([
  'cCCS1',
  'cCCS2',
  'cG105',
  'cTesla',
  'cType1',
  'cType2',
  's309-1P-16A',
  's309-1P-32A',
  's309-3P-16A',
  's309-3P-32A',
  'sBS1361',
  'sCEE-7-7',
  'sType2',
  'sType3',
  'Other1PhMax16A',
  'Other1PhOver16A',
  'Other3Ph',
  'Pan',
  'wInductive',
  'wResonant',
  'Undetermined',
  'Unknown',
]);
export type ConnectorEnumType = Infer<typeof ConnectorEnumSchema>;
export const ConnectorStatusEnumSchema = oneOf([
  'Available',
  'Occupied',
  'Reserved',
  'Unavailable',
  'Faulted',
]);
export type ConnectorStatusEnumType = Infer<typeof ConnectorStatusEnumSchema>;
export const CostKindEnumSchema = oneOf([
  'CarbonDioxideEmission',
  'RelativePricePercentage',
  'RenewableGenerationPercentage',
]);
export type CostKindEnumType = Infer<typeof CostKindEnumSchema>;
export const CustomerInformationStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'Invalid']);
export type CustomerInformationStatusEnumType = Infer<typeof CustomerInformationStatusEnumSchema>;
export const DataEnumSchema = oneOf([
  'string',
  'decimal',
  'integer',
  'dateTime',
  'boolean',
  'OptionList',
  'SequenceList',
  'MemberList',
]);
export type DataEnumType = Infer<typeof DataEnumSchema>;
export const DataTransferStatusEnumSchema = oneOf([
  'Accepted',
  'Rejected',
  'UnknownMessageId',
  'UnknownVendorId',
]);
export type DataTransferStatusEnumType = Infer<typeof DataTransferStatusEnumSchema>;
export const DeleteCertificateStatusEnumSchema = oneOf(['Accepted', 'Failed', 'NotFound']);
export type DeleteCertificateStatusEnumType = Infer<typeof DeleteCertificateStatusEnumSchema>;
export const DisplayMessageStatusEnumSchema = oneOf([
  'Accepted',
  'NotSupportedMessageFormat',
  'Rejected',
  'NotSupportedPriority',
  'NotSupportedState',
  'UnknownTransaction',
]);
export type DisplayMessageStatusEnumType = Infer<typeof DisplayMessageStatusEnumSchema>;
export const EnergyTransferModeEnumSchema = oneOf([
  'DC',
  'AC_single_phase',
  'AC_two_phase',
  'AC_three_phase',
]);
export type EnergyTransferModeEnumType = Infer<typeof EnergyTransferModeEnumSchema>;
export const EventNotificationEnumSchema = oneOf([
  'HardWiredNotification',
  'HardWiredMonitor',
  'PreconfiguredMonitor',
  'CustomMonitor',
]);
export type EventNotificationEnumType = Infer<typeof EventNotificationEnumSchema>;
export const EventTriggerEnumSchema = oneOf(['Alerting', 'Delta', 'Periodic']);
export type EventTriggerEnumType = Infer<typeof EventTriggerEnumSchema>;
export const FirmwareStatusEnumSchema = oneOf([
  'Downloaded',
  'DownloadFailed',
  'Downloading',
  'DownloadScheduled',
  'DownloadPaused',
  'Idle',
  'InstallationFailed',
  'Installing',
  'Installed',
  'InstallRebooting',
  'InstallScheduled',
  'InstallVerificationFailed',
  'InvalidSignature',
  'SignatureVerified',
]);
export type FirmwareStatusEnumType = Infer<typeof FirmwareStatusEnumSchema>;
export const GenericDeviceModelStatusEnumSchema = oneOf([
  'Accepted',
  'Rejected',
  'NotSupported',
  'EmptyResultSet',
]);
export type GenericDeviceModelStatusEnumType = Infer<typeof GenericDeviceModelStatusEnumSchema>;
export const GenericStatusEnumSchema = oneOf(['Accepted', 'Rejected']);
export type GenericStatusEnumType = Infer<typeof GenericStatusEnumSchema>;
export const GetCertificateIdUseEnumSchema = oneOf([
  'V2GRootCertificate',
  'MORootCertificate',
  'CSMSRootCertificate',
  'V2GCertificateChain',
  'ManufacturerRootCertificate',
]);
export type GetCertificateIdUseEnumType = Infer<typeof GetCertificateIdUseEnumSchema>;
export const GetCertificateStatusEnumSchema = oneOf(['Accepted', 'Failed']);
export type GetCertificateStatusEnumType = Infer<typeof GetCertificateStatusEnumSchema>;
export const GetChargingProfileStatusEnumSchema = oneOf(['Accepted', 'NoProfiles']);
export type GetChargingProfileStatusEnumType = Infer<typeof GetChargingProfileStatusEnumSchema>;
export const GetDisplayMessagesStatusEnumSchema = oneOf(['Accepted', 'Unknown']);
export type GetDisplayMessagesStatusEnumType = Infer<typeof GetDisplayMessagesStatusEnumSchema>;
export const GetInstalledCertificateStatusEnumSchema = oneOf(['Accepted', 'NotFound']);
export type GetInstalledCertificateStatusEnumType = Infer<
  typeof GetInstalledCertificateStatusEnumSchema
>;
export const GetVariableStatusEnumSchema = oneOf([
  'Accepted',
  'Rejected',
  'UnknownComponent',
  'UnknownVariable',
  'NotSupportedAttributeType',
]);
export type GetVariableStatusEnumType = Infer<typeof GetVariableStatusEnumSchema>;
export const HashAlgorithmEnumSchema = oneOf(['SHA256', 'SHA384', 'SHA512']);
export type HashAlgorithmEnumType = Infer<typeof HashAlgorithmEnumSchema>;
export const IdTokenEnumSchema = oneOf([
  'Central',
  'eMAID',
  'ISO14443',
  'ISO15693',
  'KeyCode',
  'Local',
  'MacAddress',
  'NoAuthorization',
]);
export type IdTokenEnumType = Infer<typeof IdTokenEnumSchema>;
export const InstallCertificateStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'Failed']);
export type InstallCertificateStatusEnumType = Infer<typeof InstallCertificateStatusEnumSchema>;
export const InstallCertificateUseEnumSchema = oneOf([
  'V2GRootCertificate',
  'MORootCertificate',
  'CSMSRootCertificate',
  'ManufacturerRootCertificate',
]);
export type InstallCertificateUseEnumType = Infer<typeof InstallCertificateUseEnumSchema>;
export const Iso15118EVCertificateStatusEnumSchema = oneOf(['Accepted', 'Failed']);
export type Iso15118EVCertificateStatusEnumType = Infer<
  typeof Iso15118EVCertificateStatusEnumSchema
>;
export const LocationEnumSchema = oneOf(['Body', 'Cable', 'EV', 'Inlet', 'Outlet']);
export type LocationEnumType = Infer<typeof LocationEnumSchema>;
export const LogEnumSchema = oneOf(['DiagnosticsLog', 'SecurityLog']);
export type LogEnumType = Infer<typeof LogEnumSchema>;
export const LogStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'AcceptedCanceled']);
export type LogStatusEnumType = Infer<typeof LogStatusEnumSchema>;
export const MeasurandEnumSchema = oneOf([
  'Current.Export',
  'Current.Import',
  'Current.Offered',
  'Energy.Active.Export.Register',
  'Energy.Active.Import.Register',
  'Energy.Reactive.Export.Register',
  'Energy.Reactive.Import.Register',
  'Energy.Active.Export.Interval',
  'Energy.Active.Import.Interval',
  'Energy.Active.Net',
  'Energy.Reactive.Export.Interval',
  'Energy.Reactive.Import.Interval',
  'Energy.Reactive.Net',
  'Energy.Apparent.Net',
  'Energy.Apparent.Import',
  'Energy.Apparent.Export',
  'Frequency',
  'Power.Active.Export',
  'Power.Active.Import',
  'Power.Factor',
  'Power.Offered',
  'Power.Reactive.Export',
  'Power.Reactive.Import',
  'SoC',
  'Voltage',
]);
export type MeasurandEnumType = Infer<typeof MeasurandEnumSchema>;
export const MessageFormatEnumSchema = oneOf(['ASCII', 'HTML', 'URI', 'UTF8']);
export type MessageFormatEnumType = Infer<typeof MessageFormatEnumSchema>;
export const MessagePriorityEnumSchema = oneOf(['AlwaysFront', 'InFront', 'NormalCycle']);
export type MessagePriorityEnumType = Infer<typeof MessagePriorityEnumSchema>;
export const MessageStateEnumSchema = oneOf(['Charging', 'Faulted', 'Idle', 'Unavailable']);
export type MessageStateEnumType = Infer<typeof MessageStateEnumSchema>;
export const MessageTriggerEnumSchema = oneOf([
  'BootNotification',
  'LogStatusNotification',
  'FirmwareStatusNotification',
  'Heartbeat',
  'MeterValues',
  'SignChargingStationCertificate',
  'SignV2GCertificate',
  'StatusNotification',
  'TransactionEvent',
  'SignCombinedCertificate',
  'PublishFirmwareStatusNotification',
]);
export type MessageTriggerEnumType = Infer<typeof MessageTriggerEnumSchema>;
export const MonitorEnumSchema = oneOf([
  'UpperThreshold',
  'LowerThreshold',
  'Delta',
  'Periodic',
  'PeriodicClockAligned',
]);
export type MonitorEnumType = Infer<typeof MonitorEnumSchema>;
export const MonitoringBaseEnumSchema = oneOf(['All', 'FactoryDefault', 'HardWiredOnly']);
export type MonitoringBaseEnumType = Infer<typeof MonitoringBaseEnumSchema>;
export const MonitoringCriterionEnumSchema = oneOf([
  'ThresholdMonitoring',
  'DeltaMonitoring',
  'PeriodicMonitoring',
]);
export type MonitoringCriterionEnumType = Infer<typeof MonitoringCriterionEnumSchema>;
export const MutabilityEnumSchema = oneOf(['ReadOnly', 'WriteOnly', 'ReadWrite']);
export type MutabilityEnumType = Infer<typeof MutabilityEnumSchema>;
export const NotifyEVChargingNeedsStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'Processing']);
export type NotifyEVChargingNeedsStatusEnumType = Infer<
  typeof NotifyEVChargingNeedsStatusEnumSchema
>;
export const OCPPInterfaceEnumSchema = oneOf([
  'Wired0',
  'Wired1',
  'Wired2',
  'Wired3',
  'Wireless0',
  'Wireless1',
  'Wireless2',
  'Wireless3',
]);
export type OCPPInterfaceEnumType = Infer<typeof OCPPInterfaceEnumSchema>;
export const OCPPTransportEnumSchema = oneOf(['JSON', 'SOAP']);
export type OCPPTransportEnumType = Infer<typeof OCPPTransportEnumSchema>;
export const OCPPVersionEnumSchema = oneOf(['OCPP12', 'OCPP15', 'OCPP16', 'OCPP20']);
export type OCPPVersionEnumType = Infer<typeof OCPPVersionEnumSchema>;
export const OperationalStatusEnumSchema = oneOf(['Inoperative', 'Operative']);
export type OperationalStatusEnumType = Infer<typeof OperationalStatusEnumSchema>;
export const PhaseEnumSchema = oneOf([
  'L1',
  'L2',
  'L3',
  'N',
  'L1-N',
  'L2-N',
  'L3-N',
  'L1-L2',
  'L2-L3',
  'L3-L1',
]);
export type PhaseEnumType = Infer<typeof PhaseEnumSchema>;
export const PublishFirmwareStatusEnumSchema = oneOf([
  'Idle',
  'DownloadScheduled',
  'Downloading',
  'Downloaded',
  'Published',
  'DownloadFailed',
  'DownloadPaused',
  'InvalidChecksum',
  'ChecksumVerified',
  'PublishFailed',
]);
export type PublishFirmwareStatusEnumType = Infer<typeof PublishFirmwareStatusEnumSchema>;
export const ReadingContextEnumSchema = oneOf([
  'Interruption.Begin',
  'Interruption.End',
  'Other',
  'Sample.Clock',
  'Sample.Periodic',
  'Transaction.Begin',
  'Transaction.End',
  'Trigger',
]);
export type ReadingContextEnumType = Infer<typeof ReadingContextEnumSchema>;
export const ReasonEnumSchema = oneOf([
  'DeAuthorized',
  'EmergencyStop',
  'EnergyLimitReached',
  'EVDisconnected',
  'GroundFault',
  'ImmediateReset',
  'Local',
  'LocalOutOfCredit',
  'MasterPass',
  'Other',
  'OvercurrentFault',
  'PowerLoss',
  'PowerQuality',
  'Reboot',
  'Remote',
  'SOCLimitReached',
  'StoppedByEV',
  'TimeLimitReached',
  'Timeout',
]);
export type ReasonEnumType = Infer<typeof ReasonEnumSchema>;
export const RecurrencyKindEnumSchema = oneOf(['Daily', 'Weekly']);
export type RecurrencyKindEnumType = Infer<typeof RecurrencyKindEnumSchema>;
export const RegistrationStatusEnumSchema = oneOf(['Accepted', 'Pending', 'Rejected']);
export type RegistrationStatusEnumType = Infer<typeof RegistrationStatusEnumSchema>;
export const ReportBaseEnumSchema = oneOf([
  'ConfigurationInventory',
  'FullInventory',
  'SummaryInventory',
]);
export type ReportBaseEnumType = Infer<typeof ReportBaseEnumSchema>;
export const RequestStartStopStatusEnumSchema = oneOf(['Accepted', 'Rejected']);
export type RequestStartStopStatusEnumType = Infer<typeof RequestStartStopStatusEnumSchema>;
export const ReservationUpdateStatusEnumSchema = oneOf(['Expired', 'Removed']);
export type ReservationUpdateStatusEnumType = Infer<typeof ReservationUpdateStatusEnumSchema>;
export const ReserveNowStatusEnumSchema = oneOf([
  'Accepted',
  'Faulted',
  'Occupied',
  'Rejected',
  'Unavailable',
]);
export type ReserveNowStatusEnumType = Infer<typeof ReserveNowStatusEnumSchema>;
export const ResetEnumSchema = oneOf(['Immediate', 'OnIdle']);
export type ResetEnumType = Infer<typeof ResetEnumSchema>;
export const ResetStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'Scheduled']);
export type ResetStatusEnumType = Infer<typeof ResetStatusEnumSchema>;
export const SendLocalListStatusEnumSchema = oneOf(['Accepted', 'Failed', 'VersionMismatch']);
export type SendLocalListStatusEnumType = Infer<typeof SendLocalListStatusEnumSchema>;
export const SetMonitoringStatusEnumSchema = oneOf([
  'Accepted',
  'UnknownComponent',
  'UnknownVariable',
  'UnsupportedMonitorType',
  'Rejected',
  'Duplicate',
]);
export type SetMonitoringStatusEnumType = Infer<typeof SetMonitoringStatusEnumSchema>;
export const SetNetworkProfileStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'Failed']);
export type SetNetworkProfileStatusEnumType = Infer<typeof SetNetworkProfileStatusEnumSchema>;
export const SetVariableStatusEnumSchema = oneOf([
  'Accepted',
  'Rejected',
  'UnknownComponent',
  'UnknownVariable',
  'NotSupportedAttributeType',
  'RebootRequired',
]);
export type SetVariableStatusEnumType = Infer<typeof SetVariableStatusEnumSchema>;
export const TransactionEventEnumSchema = oneOf(['Ended', 'Started', 'Updated']);
export type TransactionEventEnumType = Infer<typeof TransactionEventEnumSchema>;
export const TriggerMessageStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'NotImplemented']);
export type TriggerMessageStatusEnumType = Infer<typeof TriggerMessageStatusEnumSchema>;
export const TriggerReasonEnumSchema = oneOf([
  'Authorized',
  'CablePluggedIn',
  'ChargingRateChanged',
  'ChargingStateChanged',
  'Deauthorized',
  'EnergyLimitReached',
  'EVCommunicationLost',
  'EVConnectTimeout',
  'MeterValueClock',
  'MeterValuePeriodic',
  'TimeLimitReached',
  'Trigger',
  'UnlockCommand',
  'StopAuthorized',
  'EVDeparted',
  'EVDetected',
  'RemoteStop',
  'RemoteStart',
  'AbnormalCondition',
  'SignedDataReceived',
  'ResetCommand',
]);
export type TriggerReasonEnumType = Infer<typeof TriggerReasonEnumSchema>;
export const UnlockStatusEnumSchema = oneOf([
  'Unlocked',
  'UnlockFailed',
  'OngoingAuthorizedTransaction',
  'UnknownConnector',
]);
export type UnlockStatusEnumType = Infer<typeof UnlockStatusEnumSchema>;
export const UnpublishFirmwareStatusEnumSchema = oneOf([
  'DownloadOngoing',
  'NoFirmware',
  'Unpublished',
]);
export type UnpublishFirmwareStatusEnumType = Infer<typeof UnpublishFirmwareStatusEnumSchema>;
export const UpdateEnumSchema = oneOf(['Differential', 'Full']);
export type UpdateEnumType = Infer<typeof UpdateEnumSchema>;
export const UpdateFirmwareStatusEnumSchema = oneOf([
  'Accepted',
  'Rejected',
  'AcceptedCanceled',
  'InvalidCertificate',
  'RevokedCertificate',
]);
export type UpdateFirmwareStatusEnumType = Infer<typeof UpdateFirmwareStatusEnumSchema>;
export const UploadLogStatusEnumSchema = oneOf([
  'BadMessage',
  'Idle',
  'NotSupportedOperation',
  'PermissionDenied',
  'Uploaded',
  'UploadFailure',
  'Uploading',
  'AcceptedCanceled',
]);
export type UploadLogStatusEnumType = Infer<typeof UploadLogStatusEnumSchema>;
export const VPNEnumSchema = oneOf(['IKEv2', 'IPSec', 'L2TP', 'PPTP']);
export type VPNEnumType = Infer<typeof VPNEnumSchema>;

// ---- Datatypes (Part 2, chapter 2) --------------------------------------

export const ACChargingParametersSchema = cls({
  energyAmount: integer(),
  evMinCurrent: integer(),
  evMaxCurrent: integer(),
  evMaxVoltage: integer(),
});
export type ACChargingParametersType = Infer<typeof ACChargingParametersSchema>;
export const APNSchema = cls(
  { apn: string({ maxLength: 512 }), apnAuthentication: APNAuthenticationEnumSchema },
  {
    apnUserName: string({ maxLength: 20 }),
    apnPassword: string({ maxLength: 20 }),
    simPin: integer(),
    preferredNetwork: string({ maxLength: 6 }),
    useOnlyPreferredNetwork: boolean(),
  },
);
export type APNType = Infer<typeof APNSchema>;
export const AdditionalInfoSchema = cls({
  additionalIdToken: string({ maxLength: 36 }),
  type: string({ maxLength: 50 }),
});
export type AdditionalInfoType = Infer<typeof AdditionalInfoSchema>;
export const IdTokenSchema = cls(
  { idToken: string({ maxLength: 36 }), type: IdTokenEnumSchema },
  { additionalInfo: array(AdditionalInfoSchema, { minItems: 1 }) },
);
export type IdTokenType = Infer<typeof IdTokenSchema>;
export const MessageContentSchema = cls(
  { format: MessageFormatEnumSchema, content: string({ maxLength: 512 }) },
  { language: string({ maxLength: 8 }) },
);
export type MessageContentType = Infer<typeof MessageContentSchema>;
export const IdTokenInfoSchema = cls(
  { status: AuthorizationStatusEnumSchema },
  {
    cacheExpiryDateTime: dateTime(),
    chargingPriority: integer(),
    language1: string({ maxLength: 8 }),
    evseId: array(integer(), { minItems: 1 }),
    language2: string({ maxLength: 8 }),
    groupIdToken: IdTokenSchema,
    personalMessage: MessageContentSchema,
  },
);
export type IdTokenInfoType = Infer<typeof IdTokenInfoSchema>;
export const AuthorizationDataSchema = cls(
  { idToken: IdTokenSchema },
  { idTokenInfo: IdTokenInfoSchema },
);
export type AuthorizationData = Infer<typeof AuthorizationDataSchema>;
export const CertificateHashDataSchema = cls({
  hashAlgorithm: HashAlgorithmEnumSchema,
  issuerNameHash: string({ maxLength: 128 }),
  issuerKeyHash: string({ maxLength: 128 }),
  serialNumber: string({ maxLength: 40 }),
});
export type CertificateHashDataType = Infer<typeof CertificateHashDataSchema>;
export const CertificateHashDataChainSchema = cls(
  {
    certificateType: GetCertificateIdUseEnumSchema,
    certificateHashData: CertificateHashDataSchema,
  },
  { childCertificateHashData: array(CertificateHashDataSchema, { minItems: 1, maxItems: 4 }) },
);
export type CertificateHashDataChainType = Infer<typeof CertificateHashDataChainSchema>;
export const ChargingLimitSchema = cls(
  { chargingLimitSource: ChargingLimitSourceEnumSchema },
  { isGridCritical: boolean() },
);
export type ChargingLimitType = Infer<typeof ChargingLimitSchema>;
export const DCChargingParametersSchema = cls(
  { evMaxCurrent: integer(), evMaxVoltage: integer() },
  {
    energyAmount: integer(),
    evMaxPower: integer(),
    stateOfCharge: integer({ minimum: 0, maximum: 100 }),
    evEnergyCapacity: integer(),
    fullSoC: integer({ minimum: 0, maximum: 100 }),
    bulkSoC: integer({ minimum: 0, maximum: 100 }),
  },
);
export type DCChargingParametersType = Infer<typeof DCChargingParametersSchema>;
export const ChargingNeedsSchema = cls(
  { requestedEnergyTransfer: EnergyTransferModeEnumSchema },
  {
    departureTime: dateTime(),
    acChargingParameters: ACChargingParametersSchema,
    dcChargingParameters: DCChargingParametersSchema,
  },
);
export type ChargingNeedsType = Infer<typeof ChargingNeedsSchema>;
export const ChargingProfileCriterionSchema = cls(
  {},
  {
    chargingProfilePurpose: ChargingProfilePurposeEnumSchema,
    stackLevel: integer(),
    chargingProfileId: array(integer(), { minItems: 1 }),
    chargingLimitSource: array(ChargingLimitSourceEnumSchema, { minItems: 1, maxItems: 4 }),
  },
);
export type ChargingProfileCriterionType = Infer<typeof ChargingProfileCriterionSchema>;
export const ChargingSchedulePeriodSchema = cls(
  { startPeriod: integer(), limit: number() },
  { numberPhases: integer(), phaseToUse: integer() },
);
export type ChargingSchedulePeriodType = Infer<typeof ChargingSchedulePeriodSchema>;
export const CostSchema = cls(
  { costKind: CostKindEnumSchema, amount: integer() },
  { amountMultiplier: integer() },
);
export type CostType = Infer<typeof CostSchema>;
export const ConsumptionCostSchema = cls({
  startValue: number(),
  cost: array(CostSchema, { minItems: 1, maxItems: 3 }),
});
export type ConsumptionCostType = Infer<typeof ConsumptionCostSchema>;
export const RelativeTimeIntervalSchema = cls({ start: integer() }, { duration: integer() });
export type RelativeTimeIntervalType = Infer<typeof RelativeTimeIntervalSchema>;
export const SalesTariffEntrySchema = cls(
  { relativeTimeInterval: RelativeTimeIntervalSchema },
  {
    ePriceLevel: integer({ minimum: 0 }),
    consumptionCost: array(ConsumptionCostSchema, { minItems: 1, maxItems: 3 }),
  },
);
export type SalesTariffEntryType = Infer<typeof SalesTariffEntrySchema>;
export const SalesTariffSchema = cls(
  {
    id: integer(),
    salesTariffEntry: array(SalesTariffEntrySchema, { minItems: 1, maxItems: 1024 }),
  },
  { salesTariffDescription: string({ maxLength: 32 }), numEPriceLevels: integer() },
);
export type SalesTariffType = Infer<typeof SalesTariffSchema>;
export const ChargingScheduleSchema = cls(
  {
    id: integer(),
    chargingRateUnit: ChargingRateUnitEnumSchema,
    chargingSchedulePeriod: array(ChargingSchedulePeriodSchema, { minItems: 1, maxItems: 1024 }),
  },
  {
    startSchedule: dateTime(),
    duration: integer(),
    minChargingRate: number(),
    salesTariff: SalesTariffSchema,
  },
);
export type ChargingScheduleType = Infer<typeof ChargingScheduleSchema>;
export const ChargingProfileSchema = cls(
  {
    id: integer(),
    stackLevel: integer(),
    chargingProfilePurpose: ChargingProfilePurposeEnumSchema,
    chargingProfileKind: ChargingProfileKindEnumSchema,
    chargingSchedule: array(ChargingScheduleSchema, { minItems: 1, maxItems: 3 }),
  },
  {
    recurrencyKind: RecurrencyKindEnumSchema,
    validFrom: dateTime(),
    validTo: dateTime(),
    transactionId: string({ maxLength: 36 }),
  },
);
export type ChargingProfileType = Infer<typeof ChargingProfileSchema>;
export const ModemSchema = cls(
  {},
  { iccid: string({ maxLength: 20 }), imsi: string({ maxLength: 20 }) },
);
export type ModemType = Infer<typeof ModemSchema>;
export const ChargingStationSchema = cls(
  { model: string({ maxLength: 20 }), vendorName: string({ maxLength: 50 }) },
  {
    serialNumber: string({ maxLength: 25 }),
    firmwareVersion: string({ maxLength: 50 }),
    modem: ModemSchema,
  },
);
export type ChargingStationType = Infer<typeof ChargingStationSchema>;
export const ClearChargingProfileSchema = cls(
  {},
  {
    evseId: integer(),
    chargingProfilePurpose: ChargingProfilePurposeEnumSchema,
    stackLevel: integer(),
  },
);
export type ClearChargingProfileType = Infer<typeof ClearChargingProfileSchema>;
export const StatusInfoSchema = cls(
  { reasonCode: string({ maxLength: 20 }) },
  { additionalInfo: string({ maxLength: 512 }) },
);
export type StatusInfoType = Infer<typeof StatusInfoSchema>;
export const ClearMonitoringResultSchema = cls(
  { status: ClearMonitoringStatusEnumSchema, id: integer() },
  { statusInfo: StatusInfoSchema },
);
export type ClearMonitoringResultType = Infer<typeof ClearMonitoringResultSchema>;
export const EVSESchema = cls({ id: integer() }, { connectorId: integer() });
export type EVSEType = Infer<typeof EVSESchema>;
export const ComponentSchema = cls(
  { name: string({ maxLength: 50 }) },
  { instance: string({ maxLength: 50 }), evse: EVSESchema },
);
export type ComponentType = Infer<typeof ComponentSchema>;
export const VariableSchema = cls(
  { name: string({ maxLength: 50 }) },
  { instance: string({ maxLength: 50 }) },
);
export type VariableType = Infer<typeof VariableSchema>;
export const ComponentVariableSchema = cls(
  { component: ComponentSchema },
  { variable: VariableSchema },
);
export type ComponentVariableType = Infer<typeof ComponentVariableSchema>;
export const CompositeScheduleSchema = cls({
  evseId: integer(),
  duration: integer(),
  scheduleStart: dateTime(),
  chargingRateUnit: ChargingRateUnitEnumSchema,
  chargingSchedulePeriod: array(ChargingSchedulePeriodSchema, { minItems: 1 }),
});
export type CompositeScheduleType = Infer<typeof CompositeScheduleSchema>;
export const EventDataSchema = cls(
  {
    eventId: integer(),
    timestamp: dateTime(),
    trigger: EventTriggerEnumSchema,
    actualValue: string({ maxLength: 2500 }),
    eventNotificationType: EventNotificationEnumSchema,
    component: ComponentSchema,
    variable: VariableSchema,
  },
  {
    cause: integer(),
    techCode: string({ maxLength: 50 }),
    techInfo: string({ maxLength: 500 }),
    cleared: boolean(),
    transactionId: string({ maxLength: 36 }),
    variableMonitoringId: integer(),
  },
);
export type EventDataType = Infer<typeof EventDataSchema>;
export const FirmwareSchema = cls(
  { location: string({ maxLength: 512 }), retrieveDateTime: dateTime() },
  {
    installDateTime: dateTime(),
    signingCertificate: string({ maxLength: 5500 }),
    signature: string({ maxLength: 800 }),
  },
);
export type FirmwareType = Infer<typeof FirmwareSchema>;
export const GetVariableDataSchema = cls(
  { component: ComponentSchema, variable: VariableSchema },
  { attributeType: AttributeEnumSchema },
);
export type GetVariableDataType = Infer<typeof GetVariableDataSchema>;
export const GetVariableResultSchema = cls(
  {
    attributeStatus: GetVariableStatusEnumSchema,
    component: ComponentSchema,
    variable: VariableSchema,
  },
  {
    attributeType: AttributeEnumSchema,
    attributeValue: string({ maxLength: 2500 }),
    attributeStatusInfo: StatusInfoSchema,
  },
);
export type GetVariableResultType = Infer<typeof GetVariableResultSchema>;
export const LogParametersSchema = cls(
  { remoteLocation: string({ maxLength: 512 }) },
  { oldestTimestamp: dateTime(), latestTimestamp: dateTime() },
);
export type LogParametersType = Infer<typeof LogParametersSchema>;
export const MessageInfoSchema = cls(
  { id: integer(), priority: MessagePriorityEnumSchema, message: MessageContentSchema },
  {
    state: MessageStateEnumSchema,
    startDateTime: dateTime(),
    endDateTime: dateTime(),
    transactionId: string({ maxLength: 36 }),
    display: ComponentSchema,
  },
);
export type MessageInfoType = Infer<typeof MessageInfoSchema>;
export const SignedMeterValueSchema = cls({
  signedMeterData: string({ maxLength: 2500 }),
  signingMethod: string({ maxLength: 50 }),
  encodingMethod: string({ maxLength: 50 }),
  publicKey: string({ maxLength: 2500 }),
});
export type SignedMeterValueType = Infer<typeof SignedMeterValueSchema>;
export const UnitOfMeasureSchema = cls(
  {},
  { unit: string({ maxLength: 20 }), multiplier: integer() },
);
export type UnitOfMeasureType = Infer<typeof UnitOfMeasureSchema>;
export const SampledValueSchema = cls(
  { value: number() },
  {
    context: ReadingContextEnumSchema,
    measurand: MeasurandEnumSchema,
    phase: PhaseEnumSchema,
    location: LocationEnumSchema,
    signedMeterValue: SignedMeterValueSchema,
    unitOfMeasure: UnitOfMeasureSchema,
  },
);
export type SampledValueType = Infer<typeof SampledValueSchema>;
export const MeterValueSchema = cls({
  timestamp: dateTime(),
  sampledValue: array(SampledValueSchema, { minItems: 1 }),
});
export type MeterValueType = Infer<typeof MeterValueSchema>;
export const VariableMonitoringSchema = cls({
  id: integer(),
  transaction: boolean(),
  value: number(),
  type: MonitorEnumSchema,
  severity: integer(),
});
export type VariableMonitoringType = Infer<typeof VariableMonitoringSchema>;
export const MonitoringDataSchema = cls({
  component: ComponentSchema,
  variable: VariableSchema,
  variableMonitoring: array(VariableMonitoringSchema, { minItems: 1 }),
});
export type MonitoringDataType = Infer<typeof MonitoringDataSchema>;
export const VPNSchema = cls(
  {
    server: string({ maxLength: 512 }),
    user: string({ maxLength: 20 }),
    password: string({ maxLength: 20 }),
    key: string({ maxLength: 255 }),
    type: VPNEnumSchema,
  },
  { group: string({ maxLength: 20 }) },
);
export type VPNType = Infer<typeof VPNSchema>;
export const NetworkConnectionProfileSchema = cls(
  {
    ocppVersion: OCPPVersionEnumSchema,
    ocppTransport: OCPPTransportEnumSchema,
    ocppCsmsUrl: string({ maxLength: 512 }),
    messageTimeout: integer(),
    securityProfile: integer(),
    ocppInterface: OCPPInterfaceEnumSchema,
  },
  { vpn: VPNSchema, apn: APNSchema },
);
export type NetworkConnectionProfileType = Infer<typeof NetworkConnectionProfileSchema>;
export const OCSPRequestDataSchema = cls({
  hashAlgorithm: HashAlgorithmEnumSchema,
  issuerNameHash: string({ maxLength: 128 }),
  issuerKeyHash: string({ maxLength: 128 }),
  serialNumber: string({ maxLength: 40 }),
  responderURL: string({ maxLength: 512 }),
});
export type OCSPRequestDataType = Infer<typeof OCSPRequestDataSchema>;
export const VariableAttributeSchema = cls(
  {},
  {
    type: AttributeEnumSchema,
    value: string({ maxLength: 2500 }),
    mutability: MutabilityEnumSchema,
    persistent: boolean(),
    constant: boolean(),
  },
);
export type VariableAttributeType = Infer<typeof VariableAttributeSchema>;
export const VariableCharacteristicsSchema = cls(
  { dataType: DataEnumSchema, supportsMonitoring: boolean() },
  {
    unit: string({ maxLength: 16 }),
    minLimit: number(),
    maxLimit: number(),
    valuesList: string({ maxLength: 1000 }),
  },
);
export type VariableCharacteristicsType = Infer<typeof VariableCharacteristicsSchema>;
export const ReportDataSchema = cls(
  {
    component: ComponentSchema,
    variable: VariableSchema,
    variableAttribute: array(VariableAttributeSchema, { minItems: 1, maxItems: 4 }),
  },
  { variableCharacteristics: VariableCharacteristicsSchema },
);
export type ReportDataType = Infer<typeof ReportDataSchema>;
export const SetMonitoringDataSchema = cls(
  {
    value: number(),
    type: MonitorEnumSchema,
    severity: integer(),
    component: ComponentSchema,
    variable: VariableSchema,
  },
  { id: integer(), transaction: boolean() },
);
export type SetMonitoringDataType = Infer<typeof SetMonitoringDataSchema>;
export const SetMonitoringResultSchema = cls(
  {
    status: SetMonitoringStatusEnumSchema,
    type: MonitorEnumSchema,
    severity: integer(),
    component: ComponentSchema,
    variable: VariableSchema,
  },
  { id: integer(), statusInfo: StatusInfoSchema },
);
export type SetMonitoringResultType = Infer<typeof SetMonitoringResultSchema>;
export const SetVariableDataSchema = cls(
  {
    attributeValue: string({ maxLength: 1000 }),
    component: ComponentSchema,
    variable: VariableSchema,
  },
  { attributeType: AttributeEnumSchema },
);
export type SetVariableDataType = Infer<typeof SetVariableDataSchema>;
export const SetVariableResultSchema = cls(
  {
    attributeStatus: SetVariableStatusEnumSchema,
    component: ComponentSchema,
    variable: VariableSchema,
  },
  { attributeType: AttributeEnumSchema, attributeStatusInfo: StatusInfoSchema },
);
export type SetVariableResultType = Infer<typeof SetVariableResultSchema>;
export const TransactionSchema = cls(
  { transactionId: string({ maxLength: 36 }) },
  {
    chargingState: ChargingStateEnumSchema,
    timeSpentCharging: integer(),
    stoppedReason: ReasonEnumSchema,
    remoteStartId: integer(),
  },
);
export type TransactionType = Infer<typeof TransactionSchema>;

// ---- Messages (Part 2, chapter 1) ---------------------------------------

export const OCPP201_MESSAGES = {
  Authorize: {
    request: cls(
      { idToken: IdTokenSchema },
      {
        certificate: string({ maxLength: 5500 }),
        iso15118CertificateHashData: array(OCSPRequestDataSchema, { minItems: 1, maxItems: 4 }),
      },
    ),
    response: cls(
      { idTokenInfo: IdTokenInfoSchema },
      { certificateStatus: AuthorizeCertificateStatusEnumSchema },
    ),
  },
  BootNotification: {
    request: cls({ reason: BootReasonEnumSchema, chargingStation: ChargingStationSchema }),
    response: cls(
      { currentTime: dateTime(), interval: integer(), status: RegistrationStatusEnumSchema },
      { statusInfo: StatusInfoSchema },
    ),
  },
  CancelReservation: {
    request: cls({ reservationId: integer() }),
    response: cls({ status: CancelReservationStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  CertificateSigned: {
    request: cls(
      { certificateChain: string({ maxLength: 10000 }) },
      { certificateType: CertificateSigningUseEnumSchema },
    ),
    response: cls({ status: CertificateSignedStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  ChangeAvailability: {
    request: cls({ operationalStatus: OperationalStatusEnumSchema }, { evse: EVSESchema }),
    response: cls({ status: ChangeAvailabilityStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  ClearCache: {
    request: cls({}),
    response: cls({ status: ClearCacheStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  ClearChargingProfile: {
    request: cls(
      {},
      { chargingProfileId: integer(), chargingProfileCriteria: ClearChargingProfileSchema },
    ),
    response: cls(
      { status: ClearChargingProfileStatusEnumSchema },
      { statusInfo: StatusInfoSchema },
    ),
  },
  ClearDisplayMessage: {
    request: cls({ id: integer() }),
    response: cls({ status: ClearMessageStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  ClearVariableMonitoring: {
    request: cls({ id: array(integer(), { minItems: 1 }) }),
    response: cls({ clearMonitoringResult: array(ClearMonitoringResultSchema, { minItems: 1 }) }),
  },
  ClearedChargingLimit: {
    request: cls({ chargingLimitSource: ChargingLimitSourceEnumSchema }, { evseId: integer() }),
    response: cls({}),
  },
  CostUpdated: {
    request: cls({ totalCost: number(), transactionId: string({ maxLength: 36 }) }),
    response: cls({}),
  },
  CustomerInformation: {
    request: cls(
      { requestId: integer(), report: boolean(), clear: boolean() },
      {
        customerIdentifier: string({ maxLength: 64 }),
        idToken: IdTokenSchema,
        customerCertificate: CertificateHashDataSchema,
      },
    ),
    response: cls(
      { status: CustomerInformationStatusEnumSchema },
      { statusInfo: StatusInfoSchema },
    ),
  },
  DataTransfer: {
    request: cls(
      { vendorId: string({ maxLength: 255 }) },
      { messageId: string({ maxLength: 50 }), data: anyValue() },
    ),
    response: cls(
      { status: DataTransferStatusEnumSchema },
      { data: anyValue(), statusInfo: StatusInfoSchema },
    ),
  },
  DeleteCertificate: {
    request: cls({ certificateHashData: CertificateHashDataSchema }),
    response: cls({ status: DeleteCertificateStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  FirmwareStatusNotification: {
    request: cls({ status: FirmwareStatusEnumSchema }, { requestId: integer() }),
    response: cls({}),
  },
  Get15118EVCertificate: {
    request: cls({
      iso15118SchemaVersion: string({ maxLength: 50 }),
      action: CertificateActionEnumSchema,
      exiRequest: string({ maxLength: 5600 }),
    }),
    response: cls(
      { status: Iso15118EVCertificateStatusEnumSchema, exiResponse: string({ maxLength: 5600 }) },
      { statusInfo: StatusInfoSchema },
    ),
  },
  GetBaseReport: {
    request: cls({ requestId: integer(), reportBase: ReportBaseEnumSchema }),
    response: cls({ status: GenericDeviceModelStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  GetCertificateStatus: {
    request: cls({ ocspRequestData: OCSPRequestDataSchema }),
    response: cls(
      { status: GetCertificateStatusEnumSchema },
      { ocspResult: string({ maxLength: 5500 }), statusInfo: StatusInfoSchema },
    ),
  },
  GetChargingProfiles: {
    request: cls(
      { requestId: integer(), chargingProfile: ChargingProfileCriterionSchema },
      { evseId: integer() },
    ),
    response: cls({ status: GetChargingProfileStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  GetCompositeSchedule: {
    request: cls(
      { duration: integer(), evseId: integer() },
      { chargingRateUnit: ChargingRateUnitEnumSchema },
    ),
    response: cls(
      { status: GenericStatusEnumSchema },
      { schedule: CompositeScheduleSchema, statusInfo: StatusInfoSchema },
    ),
  },
  GetDisplayMessages: {
    request: cls(
      { requestId: integer() },
      {
        id: array(integer(), { minItems: 1 }),
        priority: MessagePriorityEnumSchema,
        state: MessageStateEnumSchema,
      },
    ),
    response: cls({ status: GetDisplayMessagesStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  GetInstalledCertificateIds: {
    request: cls({}, { certificateType: array(GetCertificateIdUseEnumSchema, { minItems: 1 }) }),
    response: cls(
      { status: GetInstalledCertificateStatusEnumSchema },
      {
        certificateHashDataChain: array(CertificateHashDataChainSchema, { minItems: 1 }),
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  GetLocalListVersion: {
    request: cls({}),
    response: cls({ versionNumber: integer() }),
  },
  GetLog: {
    request: cls(
      { logType: LogEnumSchema, requestId: integer(), log: LogParametersSchema },
      { retries: integer(), retryInterval: integer() },
    ),
    response: cls(
      { status: LogStatusEnumSchema },
      { filename: string({ maxLength: 255 }), statusInfo: StatusInfoSchema },
    ),
  },
  GetMonitoringReport: {
    request: cls(
      { requestId: integer() },
      {
        monitoringCriteria: array(MonitoringCriterionEnumSchema, { minItems: 1, maxItems: 3 }),
        componentVariable: array(ComponentVariableSchema, { minItems: 1 }),
      },
    ),
    response: cls({ status: GenericDeviceModelStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  GetReport: {
    request: cls(
      { requestId: integer() },
      {
        componentCriteria: array(ComponentCriterionEnumSchema, { minItems: 1, maxItems: 4 }),
        componentVariable: array(ComponentVariableSchema, { minItems: 1 }),
      },
    ),
    response: cls({ status: GenericDeviceModelStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  GetTransactionStatus: {
    request: cls({}, { transactionId: string({ maxLength: 36 }) }),
    response: cls({ messagesInQueue: boolean() }, { ongoingIndicator: boolean() }),
  },
  GetVariables: {
    request: cls({ getVariableData: array(GetVariableDataSchema, { minItems: 1 }) }),
    response: cls({ getVariableResult: array(GetVariableResultSchema, { minItems: 1 }) }),
  },
  Heartbeat: {
    request: cls({}),
    response: cls({ currentTime: dateTime() }),
  },
  InstallCertificate: {
    request: cls({
      certificateType: InstallCertificateUseEnumSchema,
      certificate: string({ maxLength: 5500 }),
    }),
    response: cls({ status: InstallCertificateStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  LogStatusNotification: {
    request: cls({ status: UploadLogStatusEnumSchema }, { requestId: integer() }),
    response: cls({}),
  },
  MeterValues: {
    request: cls({ evseId: integer(), meterValue: array(MeterValueSchema, { minItems: 1 }) }),
    response: cls({}),
  },
  NotifyChargingLimit: {
    request: cls(
      { chargingLimit: ChargingLimitSchema },
      { evseId: integer(), chargingSchedule: array(ChargingScheduleSchema, { minItems: 1 }) },
    ),
    response: cls({}),
  },
  NotifyCustomerInformation: {
    request: cls(
      {
        data: string({ maxLength: 512 }),
        seqNo: integer(),
        generatedAt: dateTime(),
        requestId: integer(),
      },
      { tbc: boolean() },
    ),
    response: cls({}),
  },
  NotifyDisplayMessages: {
    request: cls(
      { requestId: integer() },
      { tbc: boolean(), messageInfo: array(MessageInfoSchema, { minItems: 1 }) },
    ),
    response: cls({}),
  },
  NotifyEVChargingNeeds: {
    request: cls(
      { evseId: integer(), chargingNeeds: ChargingNeedsSchema },
      { maxScheduleTuples: integer() },
    ),
    response: cls(
      { status: NotifyEVChargingNeedsStatusEnumSchema },
      { statusInfo: StatusInfoSchema },
    ),
  },
  NotifyEVChargingSchedule: {
    request: cls({
      timeBase: dateTime(),
      evseId: integer(),
      chargingSchedule: ChargingScheduleSchema,
    }),
    response: cls({ status: GenericStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  NotifyEvent: {
    request: cls(
      {
        generatedAt: dateTime(),
        seqNo: integer(),
        eventData: array(EventDataSchema, { minItems: 1 }),
      },
      { tbc: boolean() },
    ),
    response: cls({}),
  },
  NotifyMonitoringReport: {
    request: cls(
      { requestId: integer(), seqNo: integer(), generatedAt: dateTime() },
      { tbc: boolean(), monitor: array(MonitoringDataSchema, { minItems: 1 }) },
    ),
    response: cls({}),
  },
  NotifyReport: {
    request: cls(
      { requestId: integer(), generatedAt: dateTime(), seqNo: integer() },
      { tbc: boolean(), reportData: array(ReportDataSchema, { minItems: 1 }) },
    ),
    response: cls({}),
  },
  PublishFirmware: {
    request: cls(
      {
        location: string({ maxLength: 512 }),
        checksum: string({ maxLength: 32 }),
        requestId: integer(),
      },
      { retries: integer(), retryInterval: integer() },
    ),
    response: cls({ status: GenericStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  PublishFirmwareStatusNotification: {
    request: cls(
      { status: PublishFirmwareStatusEnumSchema },
      { location: array(string({ maxLength: 512 }), { minItems: 1 }), requestId: integer() },
    ),
    response: cls({}),
  },
  ReportChargingProfiles: {
    request: cls(
      {
        requestId: integer(),
        chargingLimitSource: ChargingLimitSourceEnumSchema,
        evseId: integer(),
        chargingProfile: array(ChargingProfileSchema, { minItems: 1 }),
      },
      { tbc: boolean() },
    ),
    response: cls({}),
  },
  RequestStartTransaction: {
    request: cls(
      { remoteStartId: integer(), idToken: IdTokenSchema },
      { evseId: integer(), chargingProfile: ChargingProfileSchema, groupIdToken: IdTokenSchema },
    ),
    response: cls(
      { status: RequestStartStopStatusEnumSchema },
      { transactionId: string({ maxLength: 36 }), statusInfo: StatusInfoSchema },
    ),
  },
  RequestStopTransaction: {
    request: cls({ transactionId: string({ maxLength: 36 }) }),
    response: cls({ status: RequestStartStopStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  ReservationStatusUpdate: {
    request: cls({
      reservationId: integer(),
      reservationUpdateStatus: ReservationUpdateStatusEnumSchema,
    }),
    response: cls({}),
  },
  ReserveNow: {
    request: cls(
      { id: integer(), expiryDateTime: dateTime(), idToken: IdTokenSchema },
      { connectorType: ConnectorEnumSchema, evseId: integer(), groupIdToken: IdTokenSchema },
    ),
    response: cls({ status: ReserveNowStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  Reset: {
    request: cls({ type: ResetEnumSchema }, { evseId: integer() }),
    response: cls({ status: ResetStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  SecurityEventNotification: {
    request: cls(
      { type: string({ maxLength: 50 }), timestamp: dateTime() },
      { techInfo: string({ maxLength: 255 }) },
    ),
    response: cls({}),
  },
  SendLocalList: {
    request: cls(
      { versionNumber: integer(), updateType: UpdateEnumSchema },
      { localAuthorizationList: array(AuthorizationDataSchema, { minItems: 1 }) },
    ),
    response: cls({ status: SendLocalListStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  SetChargingProfile: {
    request: cls({ evseId: integer(), chargingProfile: ChargingProfileSchema }),
    response: cls({ status: ChargingProfileStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  SetDisplayMessage: {
    request: cls({ message: MessageInfoSchema }),
    response: cls({ status: DisplayMessageStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  SetMonitoringBase: {
    request: cls({ monitoringBase: MonitoringBaseEnumSchema }),
    response: cls({ status: GenericDeviceModelStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  SetMonitoringLevel: {
    request: cls({ severity: integer() }),
    response: cls({ status: GenericStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  SetNetworkProfile: {
    request: cls({ configurationSlot: integer(), connectionData: NetworkConnectionProfileSchema }),
    response: cls({ status: SetNetworkProfileStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  SetVariableMonitoring: {
    request: cls({ setMonitoringData: array(SetMonitoringDataSchema, { minItems: 1 }) }),
    response: cls({ setMonitoringResult: array(SetMonitoringResultSchema, { minItems: 1 }) }),
  },
  SetVariables: {
    request: cls({ setVariableData: array(SetVariableDataSchema, { minItems: 1 }) }),
    response: cls({ setVariableResult: array(SetVariableResultSchema, { minItems: 1 }) }),
  },
  SignCertificate: {
    request: cls(
      { csr: string({ maxLength: 5500 }) },
      { certificateType: CertificateSigningUseEnumSchema },
    ),
    response: cls({ status: GenericStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  StatusNotification: {
    request: cls({
      timestamp: dateTime(),
      connectorStatus: ConnectorStatusEnumSchema,
      evseId: integer(),
      connectorId: integer(),
    }),
    response: cls({}),
  },
  TransactionEvent: {
    request: cls(
      {
        eventType: TransactionEventEnumSchema,
        timestamp: dateTime(),
        triggerReason: TriggerReasonEnumSchema,
        seqNo: integer(),
        transactionInfo: TransactionSchema,
      },
      {
        offline: boolean(),
        numberOfPhasesUsed: integer(),
        cableMaxCurrent: integer(),
        reservationId: integer(),
        idToken: IdTokenSchema,
        evse: EVSESchema,
        meterValue: array(MeterValueSchema, { minItems: 1 }),
      },
    ),
    response: cls(
      {},
      {
        totalCost: number(),
        chargingPriority: integer(),
        idTokenInfo: IdTokenInfoSchema,
        updatedPersonalMessage: MessageContentSchema,
      },
    ),
  },
  TriggerMessage: {
    request: cls({ requestedMessage: MessageTriggerEnumSchema }, { evse: EVSESchema }),
    response: cls({ status: TriggerMessageStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  UnlockConnector: {
    request: cls({ evseId: integer(), connectorId: integer() }),
    response: cls({ status: UnlockStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
  UnpublishFirmware: {
    request: cls({ checksum: string({ maxLength: 32 }) }),
    response: cls({ status: UnpublishFirmwareStatusEnumSchema }),
  },
  UpdateFirmware: {
    request: cls(
      { requestId: integer(), firmware: FirmwareSchema },
      { retries: integer(), retryInterval: integer() },
    ),
    response: cls({ status: UpdateFirmwareStatusEnumSchema }, { statusInfo: StatusInfoSchema }),
  },
} as const satisfies Record<string, { request: Schema<unknown>; response: Schema<unknown> }>;

export type Ocpp201Action = keyof typeof OCPP201_MESSAGES;
export type Ocpp201RequestOf<A extends Ocpp201Action> = Infer<
  (typeof OCPP201_MESSAGES)[A]['request']
>;
export type Ocpp201ResponseOf<A extends Ocpp201Action> = Infer<
  (typeof OCPP201_MESSAGES)[A]['response']
>;

/** Actions a Charging Station sends (Part 2 message list); DataTransfer goes both ways. */
export const OCPP201_CHARGING_STATION_ACTIONS = [
  'Authorize',
  'BootNotification',
  'ClearedChargingLimit',
  'DataTransfer',
  'FirmwareStatusNotification',
  'Get15118EVCertificate',
  'GetCertificateStatus',
  'Heartbeat',
  'LogStatusNotification',
  'MeterValues',
  'NotifyChargingLimit',
  'NotifyCustomerInformation',
  'NotifyDisplayMessages',
  'NotifyEVChargingNeeds',
  'NotifyEVChargingSchedule',
  'NotifyEvent',
  'NotifyMonitoringReport',
  'NotifyReport',
  'PublishFirmwareStatusNotification',
  'ReportChargingProfiles',
  'ReservationStatusUpdate',
  'SecurityEventNotification',
  'SignCertificate',
  'StatusNotification',
  'TransactionEvent',
] as const satisfies readonly Ocpp201Action[];

/** Actions the CSMS sends to a Charging Station. */
export const OCPP201_CSMS_ACTIONS = [
  'CancelReservation',
  'CertificateSigned',
  'ChangeAvailability',
  'ClearCache',
  'ClearChargingProfile',
  'ClearDisplayMessage',
  'ClearVariableMonitoring',
  'CostUpdated',
  'CustomerInformation',
  'DataTransfer',
  'DeleteCertificate',
  'GetBaseReport',
  'GetChargingProfiles',
  'GetCompositeSchedule',
  'GetDisplayMessages',
  'GetInstalledCertificateIds',
  'GetLocalListVersion',
  'GetLog',
  'GetMonitoringReport',
  'GetReport',
  'GetTransactionStatus',
  'GetVariables',
  'InstallCertificate',
  'PublishFirmware',
  'RequestStartTransaction',
  'RequestStopTransaction',
  'ReserveNow',
  'Reset',
  'SendLocalList',
  'SetChargingProfile',
  'SetDisplayMessage',
  'SetMonitoringBase',
  'SetMonitoringLevel',
  'SetNetworkProfile',
  'SetVariableMonitoring',
  'SetVariables',
  'TriggerMessage',
  'UnlockConnector',
  'UnpublishFirmware',
  'UpdateFirmware',
] as const satisfies readonly Ocpp201Action[];

export function isOcpp201Action(action: string): action is Ocpp201Action {
  return Object.hasOwn(OCPP201_MESSAGES, action);
}

/** The schema module reports the 1.6 spellings; OCPP-J 2.0.1 corrected two of them. */
function as201<T>(result: ValidationResult<T>): ValidationResult<T> {
  if (result.ok) return result;
  const rename = (code: ValidationErrorCode): ValidationErrorCode =>
    code === 'FormationViolation'
      ? 'FormatViolation'
      : code === 'OccurenceConstraintViolation'
        ? 'OccurrenceConstraintViolation'
        : code;
  return {
    ok: false,
    errorCode: rename(result.errorCode),
    issues: result.issues.map((issue) => ({ ...issue, errorCode: rename(issue.errorCode) })),
  };
}

export function validateOcpp201Request<A extends Ocpp201Action>(
  action: A,
  payload: unknown,
): ValidationResult<Ocpp201RequestOf<A>> {
  return as201(validate(OCPP201_MESSAGES[action].request as Schema<Ocpp201RequestOf<A>>, payload));
}

export function validateOcpp201Response<A extends Ocpp201Action>(
  action: A,
  payload: unknown,
): ValidationResult<Ocpp201ResponseOf<A>> {
  return as201(
    validate(OCPP201_MESSAGES[action].response as Schema<Ocpp201ResponseOf<A>>, payload),
  );
}
