/**
 * OCPP 2.1 message definitions: all 91 actions with their datatypes and
 * enumerations, transcribed from the field tables of OCPP 2.1 Edition 1,
 * Part 2, "Messages, Datatypes & Enumerations" (names, types, lengths,
 * bounds, cardinalities and values), with a script over the specification's
 * text whose output was checked by hand. Every class also takes the optional
 * `customData` that Part 4 (OCPP-J) adds to all of them. Nothing here comes
 * from OCA's JSON schemas; a test in the engine cross-checks the two.
 *
 * 2.1 is a superset of 2.0.1 for every action both have, but one: no field was
 * removed and no enumeration or length was narrowed, and the only field that
 * became required is VariableMonitoringType.eventNotificationType
 * (NotifyMonitoringReport). Three
 * enumerations became open strings (IdTokenEnumType, ConnectorEnumType and
 * ChargingLimitSourceEnumType); their predefined values are in
 * `constants.ts`.
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
import { CustomDataSchema } from '../ocpp201/messages.js';

/** A 2.1 class: the fields of its table plus the optional `customData`. */
function cls<R extends Shape, O extends Shape = Record<never, never>>(required: R, optional?: O) {
  return object(required, { ...(optional ?? ({} as O)), customData: CustomDataSchema });
}

// ---- Enumerations (Part 2, chapter 3) ------------------------------------

export const APNAuthenticationEnumSchema = oneOf(['PAP', 'CHAP', 'NONE', 'AUTO']);
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
export const BatterySwapEventEnumSchema = oneOf(['BatteryIn', 'BatteryOut', 'BatteryOutTimeout']);
export type BatterySwapEventEnumType = Infer<typeof BatterySwapEventEnumSchema>;
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
  'V2G20Certificate',
]);
export type CertificateSigningUseEnumType = Infer<typeof CertificateSigningUseEnumSchema>;
export const CertificateStatusEnumSchema = oneOf(['Good', 'Revoked', 'Unknown', 'Failed']);
export type CertificateStatusEnumType = Infer<typeof CertificateStatusEnumSchema>;
export const CertificateStatusSourceEnumSchema = oneOf(['CRL', 'OCSP']);
export type CertificateStatusSourceEnumType = Infer<typeof CertificateStatusSourceEnumSchema>;
export const ChangeAvailabilityStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'Scheduled']);
export type ChangeAvailabilityStatusEnumType = Infer<typeof ChangeAvailabilityStatusEnumSchema>;
export const ChargingProfileKindEnumSchema = oneOf([
  'Absolute',
  'Recurring',
  'Relative',
  'Dynamic',
]);
export type ChargingProfileKindEnumType = Infer<typeof ChargingProfileKindEnumSchema>;
export const ChargingProfilePurposeEnumSchema = oneOf([
  'ChargingStationExternalConstraints',
  'ChargingStationMaxProfile',
  'TxDefaultProfile',
  'TxProfile',
  'PriorityCharging',
  'LocalGeneration',
]);
export type ChargingProfilePurposeEnumType = Infer<typeof ChargingProfilePurposeEnumSchema>;
export const ChargingProfileStatusEnumSchema = oneOf(['Accepted', 'Rejected']);
export type ChargingProfileStatusEnumType = Infer<typeof ChargingProfileStatusEnumSchema>;
export const ChargingRateUnitEnumSchema = oneOf(['W', 'A']);
export type ChargingRateUnitEnumType = Infer<typeof ChargingRateUnitEnumSchema>;
export const ChargingStateEnumSchema = oneOf([
  'EVConnected',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Idle',
]);
export type ChargingStateEnumType = Infer<typeof ChargingStateEnumSchema>;
export const ClearCacheStatusEnumSchema = oneOf(['Accepted', 'Rejected']);
export type ClearCacheStatusEnumType = Infer<typeof ClearCacheStatusEnumSchema>;
export const ClearChargingProfileStatusEnumSchema = oneOf(['Accepted', 'Unknown']);
export type ClearChargingProfileStatusEnumType = Infer<typeof ClearChargingProfileStatusEnumSchema>;
export const ClearMessageStatusEnumSchema = oneOf(['Accepted', 'Unknown', 'Rejected']);
export type ClearMessageStatusEnumType = Infer<typeof ClearMessageStatusEnumSchema>;
export const ClearMonitoringStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'NotFound']);
export type ClearMonitoringStatusEnumType = Infer<typeof ClearMonitoringStatusEnumSchema>;
export const ComponentCriterionEnumSchema = oneOf(['Active', 'Available', 'Enabled', 'Problem']);
export type ComponentCriterionEnumType = Infer<typeof ComponentCriterionEnumSchema>;
export const ConnectorStatusEnumSchema = oneOf([
  'Available',
  'Occupied',
  'Reserved',
  'Unavailable',
  'Faulted',
]);
export type ConnectorStatusEnumType = Infer<typeof ConnectorStatusEnumSchema>;
export const ControlModeEnumSchema = oneOf(['ScheduledControl', 'DynamicControl']);
export type ControlModeEnumType = Infer<typeof ControlModeEnumSchema>;
export const CostDimensionEnumSchema = oneOf([
  'Energy',
  'MaxCurrent',
  'MinCurrent',
  'MaxPower',
  'MinPower',
  'IdleTIme',
  'ChargingTime',
]);
export type CostDimensionEnumType = Infer<typeof CostDimensionEnumSchema>;
export const CostKindEnumSchema = oneOf([
  'CarbonDioxideEmission',
  'RelativePricePercentage',
  'RenewableGenerationPercentage',
]);
export type CostKindEnumType = Infer<typeof CostKindEnumSchema>;
export const CustomerInformationStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'Invalid']);
export type CustomerInformationStatusEnumType = Infer<typeof CustomerInformationStatusEnumSchema>;
export const DERControlEnumSchema = oneOf([
  'EnterService',
  'FreqDroop',
  'FreqWatt',
  'FixedPFAbsorb',
  'FixedPFInject',
  'FixedVar',
  'Gradients',
  'HFMustTrip',
  'HFMayTrip',
  'HVMustTrip',
  'HVMomCess',
  'HVMayTrip',
  'LimitMaxDischarge',
  'LFMustTrip',
  'LVMustTrip',
  'LVMomCess',
  'LVMayTrip',
  'PowerMonitoringMustTrip',
  'VoltVar',
  'VoltWatt',
  'WattPF',
  'WattVar',
]);
export type DERControlEnumType = Infer<typeof DERControlEnumSchema>;
export const DERControlStatusEnumSchema = oneOf([
  'Accepted',
  'Rejected',
  'NotSupported',
  'NotFound',
]);
export type DERControlStatusEnumType = Infer<typeof DERControlStatusEnumSchema>;
export const DERUnitEnumSchema = oneOf([
  'Not_Applicable',
  'PctMaxW',
  'PctMaxVar',
  'PctWAvail',
  'PctVarAvail',
  'PctEffectiveV',
]);
export type DERUnitEnumType = Infer<typeof DERUnitEnumSchema>;
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
export const DayOfWeekEnumSchema = oneOf([
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
]);
export type DayOfWeekEnumType = Infer<typeof DayOfWeekEnumSchema>;
export const DeleteCertificateStatusEnumSchema = oneOf(['Accepted', 'Failed', 'NotFound']);
export type DeleteCertificateStatusEnumType = Infer<typeof DeleteCertificateStatusEnumSchema>;
export const DisplayMessageStatusEnumSchema = oneOf([
  'Accepted',
  'NotSupportedMessageFormat',
  'Rejected',
  'NotSupportedPriority',
  'NotSupportedState',
  'UnknownTransaction',
  'LanguageNotSupported',
]);
export type DisplayMessageStatusEnumType = Infer<typeof DisplayMessageStatusEnumSchema>;
export const EnergyTransferModeEnumSchema = oneOf([
  'AC_single_phase',
  'AC_two_phase',
  'AC_three_phase',
  'DC',
  'AC_BPT',
  'AC_BPT_DER',
  'AC_DER',
  'DC_BPT',
  'DC_ACDP',
  'DC_ACDP_BPT',
  'WPT',
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
export const EvseKindEnumSchema = oneOf(['AC', 'DC']);
export type EvseKindEnumType = Infer<typeof EvseKindEnumSchema>;
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
  'OEMRootCertificate',
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
export const GridEventFaultEnumSchema = oneOf([
  'CurrentImbalance',
  'LocalEmergency',
  'LowInputPower',
  'OverCurrent',
  'OverFrequency',
  'OverVoltage',
  'PhaseRotation',
  'RemoteEmergency',
  'UnderFrequency',
  'UnderVoltage',
  'VoltageImbalance',
]);
export type GridEventFaultEnumType = Infer<typeof GridEventFaultEnumSchema>;
export const HashAlgorithmEnumSchema = oneOf(['SHA256', 'SHA384', 'SHA512']);
export type HashAlgorithmEnumType = Infer<typeof HashAlgorithmEnumSchema>;
export const InstallCertificateStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'Failed']);
export type InstallCertificateStatusEnumType = Infer<typeof InstallCertificateStatusEnumSchema>;
export const InstallCertificateUseEnumSchema = oneOf([
  'V2GRootCertificate',
  'MORootCertificate',
  'ManufacturerRootCertificate',
  'CSMSRootCertificate',
  'OEMRootCertificate',
]);
export type InstallCertificateUseEnumType = Infer<typeof InstallCertificateUseEnumSchema>;
export const IslandingDetectionEnumSchema = oneOf([
  'NoAntiIslandingSupport',
  'RoCoF',
  'UVP_OVP',
  'UFP_OFP',
  'VoltageVectorShift',
  'ZeroCrossingDetection',
  'OtherPassive',
  'ImpedanceMeasurement',
  'ImpedanceAtFrequency',
  'SlipModeFrequencyShift',
  'SandiaFrequencyShift',
  'SandiaVoltageShift',
  'FrequencyJump',
  'RCLQFactor',
  'OtherActive',
]);
export type IslandingDetectionEnumType = Infer<typeof IslandingDetectionEnumSchema>;
export const Iso15118EVCertificateStatusEnumSchema = oneOf(['Accepted', 'Failed']);
export type Iso15118EVCertificateStatusEnumType = Infer<
  typeof Iso15118EVCertificateStatusEnumSchema
>;
export const LocationEnumSchema = oneOf(['Body', 'Cable', 'EV', 'Inlet', 'Outlet', 'Upstream']);
export type LocationEnumType = Infer<typeof LocationEnumSchema>;
export const LogEnumSchema = oneOf(['DiagnosticsLog', 'SecurityLog', 'DataCollectorLog']);
export type LogEnumType = Infer<typeof LogEnumSchema>;
export const LogStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'AcceptedCanceled']);
export type LogStatusEnumType = Infer<typeof LogStatusEnumSchema>;
export const MeasurandEnumSchema = oneOf([
  'Current.Export',
  'Current.Export.Offered',
  'Current.Export.Minimum',
  'Current.Import',
  'Current.Import.Offered',
  'Current.Import.Minimum',
  'Current.Offered',
  'Display.PresentSOC',
  'Display.MinimumSOC',
  'Display.TargetSOC',
  'Display.MaximumSOC',
  'Display.RemainingTimeToMinimumSOC',
  'Display.RemainingTimeToTargetSOC',
  'Display.RemainingTimeToMaximumSOC',
  'Display.ChargingComplete',
  'Display.BatteryEnergyCapacity',
  'Display.InletHot',
  'Energy.Active.Export.Interval',
  'Energy.Active.Export.Register',
  'Energy.Active.Import.Interval',
  'Energy.Active.Import.Register',
  'Energy.Active.Import.CableLoss',
  'Energy.Active.Import.LocalGeneration.Register',
  'Energy.Active.Net',
  'Energy.Active.Setpoint.Interval',
  'Energy.Apparent.Export',
  'Energy.Apparent.Import',
  'Energy.Apparent.Net',
  'Energy.Reactive.Export.Interval',
  'Energy.Reactive.Export.Register',
  'Energy.Reactive.Import.Interval',
  'Energy.Reactive.Import.Register',
  'Energy.Reactive.Net',
  'EnergyRequest.Target',
  'EnergyRequest.Minimum',
  'EnergyRequest.Maximum',
  'EnergyRequest.Minimum.V2X',
  'EnergyRequest.Maximum.V2X',
  'EnergyRequest.Bulk',
  'Frequency',
  'Power.Active.Export',
  'Power.Active.Import',
  'Power.Active.Setpoint',
  'Power.Active.Residual',
  'Power.Export.Minimum',
  'Power.Export.Offered',
  'Power.Factor',
  'Power.Import.Offered',
  'Power.Import.Minimum',
  'Power.Offered',
  'Power.Reactive.Export',
  'Power.Reactive.Import',
  'SoC',
  'Voltage',
  'Voltage.Minimum',
  'Voltage.Maximum',
]);
export type MeasurandEnumType = Infer<typeof MeasurandEnumSchema>;
export const MessageFormatEnumSchema = oneOf(['ASCII', 'HTML', 'URI', 'UTF8', 'QRCODE']);
export type MessageFormatEnumType = Infer<typeof MessageFormatEnumSchema>;
export const MessagePriorityEnumSchema = oneOf(['AlwaysFront', 'InFront', 'NormalCycle']);
export type MessagePriorityEnumType = Infer<typeof MessagePriorityEnumSchema>;
export const MessageStateEnumSchema = oneOf([
  'Charging',
  'Faulted',
  'Idle',
  'Unavailable',
  'Suspended',
  'Discharging',
]);
export type MessageStateEnumType = Infer<typeof MessageStateEnumSchema>;
export const MessageTriggerEnumSchema = oneOf([
  'BootNotification',
  'LogStatusNotification',
  'FirmwareStatusNotification',
  'Heartbeat',
  'MeterValues',
  'SignChargingStationCertificate',
  'SignV2GCertificate',
  'SignV2G20Certificate',
  'StatusNotification',
  'TransactionEvent',
  'SignCombinedCertificate',
  'PublishFirmwareStatusNotification',
  'CustomTrigger',
]);
export type MessageTriggerEnumType = Infer<typeof MessageTriggerEnumSchema>;
export const MobilityNeedsModeEnumSchema = oneOf(['EVCC', 'EVCC_SECC']);
export type MobilityNeedsModeEnumType = Infer<typeof MobilityNeedsModeEnumSchema>;
export const MonitorEnumSchema = oneOf([
  'UpperThreshold',
  'LowerThreshold',
  'Delta',
  'Periodic',
  'PeriodicClockAligned',
  'TargetDelta',
  'TargetDeltaRelative',
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
export const NotifyAllowedEnergyTransferStatusEnumSchema = oneOf(['Accepted', 'Rejected']);
export type NotifyAllowedEnergyTransferStatusEnumType = Infer<
  typeof NotifyAllowedEnergyTransferStatusEnumSchema
>;
export const NotifyEVChargingNeedsStatusEnumSchema = oneOf([
  'Accepted',
  'Rejected',
  'Processing',
  'NoChargingProfile',
]);
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
  'Any',
]);
export type OCPPInterfaceEnumType = Infer<typeof OCPPInterfaceEnumSchema>;
export const OCPPTransportEnumSchema = oneOf(['SOAP', 'JSON']);
export type OCPPTransportEnumType = Infer<typeof OCPPTransportEnumSchema>;
export const OCPPVersionEnumSchema = oneOf([
  'OCPP12',
  'OCPP15',
  'OCPP16',
  'OCPP20',
  'OCPP201',
  'OCPP21',
]);
export type OCPPVersionEnumType = Infer<typeof OCPPVersionEnumSchema>;
export const OperationModeEnumSchema = oneOf([
  'Idle',
  'ChargingOnly',
  'CentralSetpoint',
  'ExternalSetpoint',
  'ExternalLimits',
  'CentralFrequency',
  'LocalFrequency',
  'LocalLoadBalancing',
]);
export type OperationModeEnumType = Infer<typeof OperationModeEnumSchema>;
export const OperationalStatusEnumSchema = oneOf(['Inoperative', 'Operative']);
export type OperationalStatusEnumType = Infer<typeof OperationalStatusEnumSchema>;
export const PaymentStatusEnumSchema = oneOf(['Settled', 'Canceled', 'Rejected', 'Failed']);
export type PaymentStatusEnumType = Infer<typeof PaymentStatusEnumSchema>;
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
export const PowerDuringCessationEnumSchema = oneOf(['Active', 'Reactive']);
export type PowerDuringCessationEnumType = Infer<typeof PowerDuringCessationEnumSchema>;
export const PreconditioningStatusEnumSchema = oneOf([
  'Unknown',
  'Ready',
  'NotReady',
  'Preconditioning',
]);
export type PreconditioningStatusEnumType = Infer<typeof PreconditioningStatusEnumSchema>;
export const PriorityChargingStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'NoProfile']);
export type PriorityChargingStatusEnumType = Infer<typeof PriorityChargingStatusEnumSchema>;
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
  'MasterPass',
  'Local',
  'LocalOutOfCredit',
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
  'ReqEnergyTransferRejected',
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
export const ReservationUpdateStatusEnumSchema = oneOf(['Expired', 'Removed', 'NoTransaction']);
export type ReservationUpdateStatusEnumType = Infer<typeof ReservationUpdateStatusEnumSchema>;
export const ReserveNowStatusEnumSchema = oneOf([
  'Accepted',
  'Faulted',
  'Occupied',
  'Rejected',
  'Unavailable',
]);
export type ReserveNowStatusEnumType = Infer<typeof ReserveNowStatusEnumSchema>;
export const ResetEnumSchema = oneOf(['Immediate', 'OnIdle', 'ImmediateAndResume']);
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
export const TariffChangeStatusEnumSchema = oneOf([
  'Accepted',
  'Rejected',
  'TooManyElements',
  'ConditionNotSupported',
  'TxNotFound',
  'NoCurrencyChange',
]);
export type TariffChangeStatusEnumType = Infer<typeof TariffChangeStatusEnumSchema>;
export const TariffClearStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'NoTariff']);
export type TariffClearStatusEnumType = Infer<typeof TariffClearStatusEnumSchema>;
export const TariffCostEnumSchema = oneOf(['NormalCost', 'MinCost', 'MaxCost']);
export type TariffCostEnumType = Infer<typeof TariffCostEnumSchema>;
export const TariffGetStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'NoTariff']);
export type TariffGetStatusEnumType = Infer<typeof TariffGetStatusEnumSchema>;
export const TariffKindEnumSchema = oneOf(['DefaultTariff', 'DriverTariff']);
export type TariffKindEnumType = Infer<typeof TariffKindEnumSchema>;
export const TariffSetStatusEnumSchema = oneOf([
  'Accepted',
  'Rejected',
  'TooManyElements',
  'ConditionNotSupported',
  'DuplicateTariffId',
]);
export type TariffSetStatusEnumType = Infer<typeof TariffSetStatusEnumSchema>;
export const TransactionEventEnumSchema = oneOf(['Ended', 'Started', 'Updated']);
export type TransactionEventEnumType = Infer<typeof TransactionEventEnumSchema>;
export const TriggerMessageStatusEnumSchema = oneOf(['Accepted', 'Rejected', 'NotImplemented']);
export type TriggerMessageStatusEnumType = Infer<typeof TriggerMessageStatusEnumSchema>;
export const TriggerReasonEnumSchema = oneOf([
  'AbnormalCondition',
  'Authorized',
  'CablePluggedIn',
  'ChargingRateChanged',
  'ChargingStateChanged',
  'CostLimitReached',
  'Deauthorized',
  'EnergyLimitReached',
  'EVCommunicationLost',
  'EVConnectTimeout',
  'EVDeparted',
  'EVDetected',
  'LimitSet',
  'MeterValueClock',
  'MeterValuePeriodic',
  'OperationModeChanged',
  'RemoteStart',
  'RemoteStop',
  'ResetCommand',
  'RunningCost',
  'SignedDataReceived',
  'SoCLimitReached',
  'StopAuthorized',
  'TariffChanged',
  'TariffNotAccepted',
  'TimeLimitReached',
  'Trigger',
  'TxResumed',
  'UnlockCommand',
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
  energyAmount: number(),
  evMinCurrent: number(),
  evMaxCurrent: number(),
  evMaxVoltage: number(),
});
export type ACChargingParametersType = Infer<typeof ACChargingParametersSchema>;
export const APNSchema = cls(
  {
    apn: string({ maxLength: 2000 }),
    apnAuthentication: APNAuthenticationEnumSchema,
  },
  {
    apnUserName: string({ maxLength: 50 }),
    apnPassword: string({ maxLength: 64 }),
    simPin: integer(),
    preferredNetwork: string({ maxLength: 6 }),
    useOnlyPreferredNetwork: boolean(),
  },
);
export type APNType = Infer<typeof APNSchema>;
export const RationalNumberSchema = cls({
  exponent: integer(),
  value: integer(),
});
export type RationalNumberType = Infer<typeof RationalNumberSchema>;
export const AdditionalSelectedServicesSchema = cls({
  serviceName: string({ maxLength: 80 }),
  serviceFee: RationalNumberSchema,
});
export type AdditionalSelectedServicesType = Infer<typeof AdditionalSelectedServicesSchema>;
export const OverstayRuleSchema = cls(
  {
    startTime: integer(),
    overstayFeePeriod: integer(),
    overstayFee: RationalNumberSchema,
  },
  {
    overstayRuleDescription: string({ maxLength: 32 }),
  },
);
export type OverstayRuleType = Infer<typeof OverstayRuleSchema>;
export const OverstayRuleListSchema = cls(
  {
    overstayRule: array(OverstayRuleSchema, { minItems: 1, maxItems: 5 }),
  },
  {
    overstayTimeThreshold: integer(),
    overstayPowerThreshold: RationalNumberSchema,
  },
);
export type OverstayRuleListType = Infer<typeof OverstayRuleListSchema>;
export const PriceRuleSchema = cls(
  {
    energyFee: RationalNumberSchema,
    powerRangeStart: RationalNumberSchema,
  },
  {
    parkingFeePeriod: integer(),
    carbonDioxideEmission: integer({ minimum: 0 }),
    renewableGenerationPercentage: integer({ minimum: 0, maximum: 100 }),
    parkingFee: RationalNumberSchema,
  },
);
export type PriceRuleType = Infer<typeof PriceRuleSchema>;
export const PriceRuleStackSchema = cls({
  duration: integer(),
  priceRule: array(PriceRuleSchema, { minItems: 1, maxItems: 8 }),
});
export type PriceRuleStackType = Infer<typeof PriceRuleStackSchema>;
export const TaxRuleSchema = cls(
  {
    taxRuleID: integer({ minimum: 0 }),
    appliesToEnergyFee: boolean(),
    appliesToParkingFee: boolean(),
    appliesToOverstayFee: boolean(),
    appliesToMinimumMaximumCost: boolean(),
    taxRate: RationalNumberSchema,
  },
  {
    taxRuleName: string({ maxLength: 100 }),
    taxIncludedInPrice: boolean(),
  },
);
export type TaxRuleType = Infer<typeof TaxRuleSchema>;
export const AbsolutePriceScheduleSchema = cls(
  {
    timeAnchor: dateTime(),
    priceScheduleID: integer({ minimum: 0 }),
    currency: string({ maxLength: 3 }),
    language: string({ maxLength: 8 }),
    priceAlgorithm: string({ maxLength: 2000 }),
    priceRuleStacks: array(PriceRuleStackSchema, { minItems: 1, maxItems: 1024 }),
  },
  {
    priceScheduleDescription: string({ maxLength: 160 }),
    taxRules: array(TaxRuleSchema, { minItems: 1, maxItems: 10 }),
    additionalSelectedServices: array(AdditionalSelectedServicesSchema, {
      minItems: 1,
      maxItems: 5,
    }),
    overstayRuleList: OverstayRuleListSchema,
    minimumCost: RationalNumberSchema,
    maximumCost: RationalNumberSchema,
  },
);
export type AbsolutePriceScheduleType = Infer<typeof AbsolutePriceScheduleSchema>;
export const AdditionalInfoSchema = cls({
  additionalIdToken: string({ maxLength: 255 }),
  type: string({ maxLength: 50 }),
});
export type AdditionalInfoType = Infer<typeof AdditionalInfoSchema>;
export const AddressSchema = cls(
  {
    name: string({ maxLength: 50 }),
    address1: string({ maxLength: 100 }),
    city: string({ maxLength: 100 }),
    country: string({ maxLength: 50 }),
  },
  {
    address2: string({ maxLength: 100 }),
    postalCode: string({ maxLength: 20 }),
  },
);
export type AddressType = Infer<typeof AddressSchema>;
export const IdTokenSchema = cls(
  {
    idToken: string({ maxLength: 255 }),
    type: string({ maxLength: 20 }),
  },
  {
    additionalInfo: array(AdditionalInfoSchema, { minItems: 1 }),
  },
);
export type IdTokenType = Infer<typeof IdTokenSchema>;
export const MessageContentSchema = cls(
  {
    format: MessageFormatEnumSchema,
    content: string({ maxLength: 1024 }),
  },
  {
    language: string({ maxLength: 8 }),
  },
);
export type MessageContentType = Infer<typeof MessageContentSchema>;
export const IdTokenInfoSchema = cls(
  {
    status: AuthorizationStatusEnumSchema,
  },
  {
    cacheExpiryDateTime: dateTime(),
    chargingPriority: integer(),
    language1: string({ maxLength: 8 }),
    language2: string({ maxLength: 8 }),
    evseId: array(integer({ minimum: 0 }), { minItems: 1 }),
    groupIdToken: IdTokenSchema,
    personalMessage: MessageContentSchema,
  },
);
export type IdTokenInfoType = Infer<typeof IdTokenInfoSchema>;
export const AuthorizationDataSchema = cls(
  {
    idToken: IdTokenSchema,
  },
  {
    idTokenInfo: IdTokenInfoSchema,
  },
);
export type AuthorizationData = Infer<typeof AuthorizationDataSchema>;
export const BatteryDataSchema = cls(
  {
    evseId: integer({ minimum: 0 }),
    serialNumber: string({ maxLength: 50 }),
    soC: number({ minimum: 0, maximum: 100 }),
    soH: number({ minimum: 0, maximum: 100 }),
  },
  {
    productionDate: dateTime(),
    vendorInfo: string({ maxLength: 500 }),
  },
);
export type BatteryDataType = Infer<typeof BatteryDataSchema>;
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
  {
    childCertificateHashData: array(CertificateHashDataSchema, { minItems: 1, maxItems: 4 }),
  },
);
export type CertificateHashDataChainType = Infer<typeof CertificateHashDataChainSchema>;
export const CertificateStatusRequestInfoSchema = cls({
  source: CertificateStatusSourceEnumSchema,
  urls: array(string({ maxLength: 2000 }), { minItems: 1, maxItems: 5 }),
  certificateHashData: CertificateHashDataSchema,
});
export type CertificateStatusRequestInfoType = Infer<typeof CertificateStatusRequestInfoSchema>;
export const CertificateStatusSchema = cls({
  source: CertificateStatusSourceEnumSchema,
  status: CertificateStatusEnumSchema,
  nextUpdate: dateTime(),
  certificateHashData: CertificateHashDataSchema,
});
export type CertificateStatusType = Infer<typeof CertificateStatusSchema>;
export const ChargingLimitSchema = cls(
  {
    chargingLimitSource: string({ maxLength: 20 }),
  },
  {
    isLocalGeneration: boolean(),
    isGridCritical: boolean(),
  },
);
export type ChargingLimitType = Infer<typeof ChargingLimitSchema>;
export const DCChargingParametersSchema = cls(
  {
    evMaxCurrent: number(),
    evMaxVoltage: number(),
  },
  {
    evMaxPower: number(),
    evEnergyCapacity: number(),
    energyAmount: number(),
    stateOfCharge: integer({ minimum: 0, maximum: 100 }),
    fullSoC: integer({ minimum: 0, maximum: 100 }),
    bulkSoC: integer({ minimum: 0, maximum: 100 }),
  },
);
export type DCChargingParametersType = Infer<typeof DCChargingParametersSchema>;
export const DERChargingParametersSchema = cls(
  {},
  {
    evSupportedDERControl: array(DERControlEnumSchema, { minItems: 1 }),
    evOverExcitedMaxDischargePower: number(),
    evOverExcitedPowerFactor: number(),
    evUnderExcitedMaxDischargePower: number(),
    evUnderExcitedPowerFactor: number(),
    maxApparentPower: number(),
    maxChargeApparentPower: number(),
    maxChargeApparentPower_L2: number(),
    maxChargeApparentPower_L3: number(),
    maxDischargeApparentPower: number(),
    maxDischargeApparentPower_L2: number(),
    maxDischargeApparentPower_L3: number(),
    maxChargeReactivePower: number(),
    maxChargeReactivePower_L2: number(),
    maxChargeReactivePower_L3: number(),
    minChargeReactivePower: number(),
    minChargeReactivePower_L2: number(),
    minChargeReactivePower_L3: number(),
    maxDischargeReactivePower: number(),
    maxDischargeReactivePower_L2: number(),
    maxDischargeReactivePower_L3: number(),
    minDischargeReactivePower: number(),
    minDischargeReactivePower_L2: number(),
    minDischargeReactivePower_L3: number(),
    nominalVoltage: number(),
    nominalVoltageOffset: number(),
    maxNominalVoltage: number(),
    minNominalVoltage: number(),
    evInverterManufacturer: string({ maxLength: 50 }),
    evInverterModel: string({ maxLength: 50 }),
    evInverterSerialNumber: string({ maxLength: 50 }),
    evInverterSwVersion: string({ maxLength: 50 }),
    evInverterHwVersion: string({ maxLength: 50 }),
    evIslandingDetectionMethod: array(IslandingDetectionEnumSchema, { minItems: 1 }),
    evIslandingTripTime: number(),
    evMaximumLevel1DCInjection: number(),
    evDurationLevel1DCInjection: number(),
    evMaximumLevel2DCInjection: number(),
    evDurationLevel2DCInjection: number(),
    evReactiveSusceptance: number(),
    evSessionTotalDischargeEnergyAvailable: number(),
  },
);
export type DERChargingParametersType = Infer<typeof DERChargingParametersSchema>;
export const EVPriceRuleSchema = cls({
  energyFee: number(),
  powerRangeStart: number(),
});
export type EVPriceRuleType = Infer<typeof EVPriceRuleSchema>;
export const EVAbsolutePriceScheduleEntrySchema = cls({
  duration: integer(),
  evPriceRule: array(EVPriceRuleSchema, { minItems: 1, maxItems: 8 }),
});
export type EVAbsolutePriceScheduleEntryType = Infer<typeof EVAbsolutePriceScheduleEntrySchema>;
export const EVAbsolutePriceScheduleSchema = cls({
  timeAnchor: dateTime(),
  currency: string({ maxLength: 3 }),
  priceAlgorithm: string({ maxLength: 2000 }),
  evAbsolutePriceScheduleEntries: array(EVAbsolutePriceScheduleEntrySchema, {
    minItems: 1,
    maxItems: 1024,
  }),
});
export type EVAbsolutePriceScheduleType = Infer<typeof EVAbsolutePriceScheduleSchema>;
export const EVPowerScheduleEntrySchema = cls({
  duration: integer(),
  power: number(),
});
export type EVPowerScheduleEntryType = Infer<typeof EVPowerScheduleEntrySchema>;
export const EVPowerScheduleSchema = cls({
  timeAnchor: dateTime(),
  evPowerScheduleEntries: array(EVPowerScheduleEntrySchema, { minItems: 1, maxItems: 1024 }),
});
export type EVPowerScheduleType = Infer<typeof EVPowerScheduleSchema>;
export const EVEnergyOfferSchema = cls(
  {
    evPowerSchedule: EVPowerScheduleSchema,
  },
  {
    evAbsolutePriceSchedule: EVAbsolutePriceScheduleSchema,
  },
);
export type EVEnergyOfferType = Infer<typeof EVEnergyOfferSchema>;
export const V2XChargingParametersSchema = cls(
  {},
  {
    minChargePower: number(),
    minChargePower_L2: number(),
    minChargePower_L3: number(),
    maxChargePower: number(),
    maxChargePower_L2: number(),
    maxChargePower_L3: number(),
    minDischargePower: number(),
    minDischargePower_L2: number(),
    minDischargePower_L3: number(),
    maxDischargePower: number(),
    maxDischargePower_L2: number(),
    maxDischargePower_L3: number(),
    minChargeCurrent: number(),
    maxChargeCurrent: number(),
    minDischargeCurrent: number(),
    maxDischargeCurrent: number(),
    minVoltage: number(),
    maxVoltage: number(),
    evTargetEnergyRequest: number(),
    evMinEnergyRequest: number(),
    evMaxEnergyRequest: number(),
    evMinV2XEnergyRequest: number(),
    evMaxV2XEnergyRequest: number(),
    targetSoC: integer({ minimum: 0, maximum: 100 }),
  },
);
export type V2XChargingParametersType = Infer<typeof V2XChargingParametersSchema>;
export const ChargingNeedsSchema = cls(
  {
    requestedEnergyTransfer: EnergyTransferModeEnumSchema,
  },
  {
    availableEnergyTransfer: array(EnergyTransferModeEnumSchema, { minItems: 1 }),
    controlMode: ControlModeEnumSchema,
    mobilityNeedsMode: MobilityNeedsModeEnumSchema,
    departureTime: dateTime(),
    v2xChargingParameters: V2XChargingParametersSchema,
    dcChargingParameters: DCChargingParametersSchema,
    acChargingParameters: ACChargingParametersSchema,
    evEnergyOffer: EVEnergyOfferSchema,
    derChargingParameters: DERChargingParametersSchema,
  },
);
export type ChargingNeedsType = Infer<typeof ChargingNeedsSchema>;
export const CostDimensionSchema = cls({
  type: CostDimensionEnumSchema,
  volume: number(),
});
export type CostDimensionType = Infer<typeof CostDimensionSchema>;
export const ChargingPeriodSchema = cls(
  {
    startPeriod: dateTime(),
  },
  {
    tariffId: string({ maxLength: 60 }),
    dimensions: array(CostDimensionSchema, { minItems: 1 }),
  },
);
export type ChargingPeriodType = Infer<typeof ChargingPeriodSchema>;
export const ChargingProfileCriterionSchema = cls(
  {},
  {
    chargingProfilePurpose: ChargingProfilePurposeEnumSchema,
    stackLevel: integer({ minimum: 0 }),
    chargingProfileId: array(integer(), { minItems: 1 }),
    chargingLimitSource: array(string({ maxLength: 20 }), { minItems: 1, maxItems: 4 }),
  },
);
export type ChargingProfileCriterionType = Infer<typeof ChargingProfileCriterionSchema>;
export const V2XFreqWattPointSchema = cls({
  frequency: number(),
  power: number(),
});
export type V2XFreqWattPointType = Infer<typeof V2XFreqWattPointSchema>;
export const V2XSignalWattPointSchema = cls({
  signal: integer(),
  power: number(),
});
export type V2XSignalWattPointType = Infer<typeof V2XSignalWattPointSchema>;
export const ChargingSchedulePeriodSchema = cls(
  {
    startPeriod: integer(),
  },
  {
    limit: number(),
    limit_L2: number(),
    limit_L3: number(),
    numberPhases: integer({ minimum: 0, maximum: 3 }),
    phaseToUse: integer({ minimum: 0, maximum: 3 }),
    dischargeLimit: number({ maximum: 0 }),
    dischargeLimit_L2: number({ maximum: 0 }),
    dischargeLimit_L3: number({ maximum: 0 }),
    setpoint: number(),
    setpoint_L2: number(),
    setpoint_L3: number(),
    setpointReactive: number(),
    setpointReactive_L2: number(),
    setpointReactive_L3: number(),
    preconditioningRequest: boolean(),
    evseSleep: boolean(),
    v2xBaseline: number(),
    operationMode: OperationModeEnumSchema,
    v2xFreqWattCurve: array(V2XFreqWattPointSchema, { minItems: 1, maxItems: 20 }),
    v2xSignalWattCurve: array(V2XSignalWattPointSchema, { minItems: 1, maxItems: 20 }),
  },
);
export type ChargingSchedulePeriodType = Infer<typeof ChargingSchedulePeriodSchema>;
export const LimitAtSoCSchema = cls({
  soc: integer({ minimum: 0, maximum: 100 }),
  limit: number(),
});
export type LimitAtSoCType = Infer<typeof LimitAtSoCSchema>;
export const PriceLevelScheduleEntrySchema = cls({
  duration: integer(),
  priceLevel: integer({ minimum: 0 }),
});
export type PriceLevelScheduleEntryType = Infer<typeof PriceLevelScheduleEntrySchema>;
export const PriceLevelScheduleSchema = cls(
  {
    timeAnchor: dateTime(),
    priceScheduleId: integer({ minimum: 0 }),
    numberOfPriceLevels: integer({ minimum: 0 }),
    priceLevelScheduleEntries: array(PriceLevelScheduleEntrySchema, { minItems: 1, maxItems: 100 }),
  },
  {
    priceScheduleDescription: string({ maxLength: 32 }),
  },
);
export type PriceLevelScheduleType = Infer<typeof PriceLevelScheduleSchema>;
export const CostSchema = cls(
  {
    costKind: CostKindEnumSchema,
    amount: integer(),
  },
  {
    amountMultiplier: integer(),
  },
);
export type CostType = Infer<typeof CostSchema>;
export const ConsumptionCostSchema = cls({
  startValue: number(),
  cost: array(CostSchema, { minItems: 1, maxItems: 3 }),
});
export type ConsumptionCostType = Infer<typeof ConsumptionCostSchema>;
export const RelativeTimeIntervalSchema = cls(
  {
    start: integer(),
  },
  {
    duration: integer(),
  },
);
export type RelativeTimeIntervalType = Infer<typeof RelativeTimeIntervalSchema>;
export const SalesTariffEntrySchema = cls(
  {
    relativeTimeInterval: RelativeTimeIntervalSchema,
  },
  {
    ePriceLevel: integer({ minimum: 0 }),
    consumptionCost: array(ConsumptionCostSchema, { minItems: 1, maxItems: 3 }),
  },
);
export type SalesTariffEntryType = Infer<typeof SalesTariffEntrySchema>;
export const SalesTariffSchema = cls(
  {
    id: integer({ minimum: 0 }),
    salesTariffEntry: array(SalesTariffEntrySchema, { minItems: 1, maxItems: 1024 }),
  },
  {
    salesTariffDescription: string({ maxLength: 32 }),
    numEPriceLevels: integer({ minimum: 0 }),
  },
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
    powerTolerance: number(),
    signatureId: integer({ minimum: 0 }),
    digestValue: string({ maxLength: 88 }),
    useLocalTime: boolean(),
    randomizedDelay: integer({ minimum: 0 }),
    salesTariff: SalesTariffSchema,
    absolutePriceSchedule: AbsolutePriceScheduleSchema,
    priceLevelSchedule: PriceLevelScheduleSchema,
    limitAtSoC: LimitAtSoCSchema,
  },
);
export type ChargingScheduleType = Infer<typeof ChargingScheduleSchema>;
export const ChargingProfileSchema = cls(
  {
    id: integer(),
    stackLevel: integer({ minimum: 0 }),
    chargingProfilePurpose: ChargingProfilePurposeEnumSchema,
    chargingProfileKind: ChargingProfileKindEnumSchema,
    chargingSchedule: array(ChargingScheduleSchema, { minItems: 1, maxItems: 3 }),
  },
  {
    recurrencyKind: RecurrencyKindEnumSchema,
    validFrom: dateTime(),
    validTo: dateTime(),
    transactionId: string({ maxLength: 36 }),
    maxOfflineDuration: integer(),
    invalidAfterOfflineDuration: boolean(),
    dynUpdateInterval: integer(),
    dynUpdateTime: dateTime(),
    priceScheduleSignature: string({ maxLength: 256 }),
  },
);
export type ChargingProfileType = Infer<typeof ChargingProfileSchema>;
export const ChargingScheduleUpdateSchema = cls(
  {},
  {
    limit: number(),
    limit_L2: number(),
    limit_L3: number(),
    dischargeLimit: number({ maximum: 0 }),
    dischargeLimit_L2: number({ maximum: 0 }),
    dischargeLimit_L3: number({ maximum: 0 }),
    setpoint: number(),
    setpoint_L2: number(),
    setpoint_L3: number(),
    setpointReactive: number(),
    setpointReactive_L2: number(),
    setpointReactive_L3: number(),
  },
);
export type ChargingScheduleUpdateType = Infer<typeof ChargingScheduleUpdateSchema>;
export const ModemSchema = cls(
  {},
  {
    iccid: string({ maxLength: 20 }),
    imsi: string({ maxLength: 20 }),
  },
);
export type ModemType = Infer<typeof ModemSchema>;
export const ChargingStationSchema = cls(
  {
    model: string({ maxLength: 20 }),
    vendorName: string({ maxLength: 50 }),
  },
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
    evseId: integer({ minimum: 0 }),
    chargingProfilePurpose: ChargingProfilePurposeEnumSchema,
    stackLevel: integer({ minimum: 0 }),
  },
);
export type ClearChargingProfileType = Infer<typeof ClearChargingProfileSchema>;
export const StatusInfoSchema = cls(
  {
    reasonCode: string({ maxLength: 20 }),
  },
  {
    additionalInfo: string({ maxLength: 1024 }),
  },
);
export type StatusInfoType = Infer<typeof StatusInfoSchema>;
export const ClearMonitoringResultSchema = cls(
  {
    status: ClearMonitoringStatusEnumSchema,
    id: integer({ minimum: 0 }),
  },
  {
    statusInfo: StatusInfoSchema,
  },
);
export type ClearMonitoringResultType = Infer<typeof ClearMonitoringResultSchema>;
export const ClearTariffsResultSchema = cls(
  {
    status: TariffClearStatusEnumSchema,
  },
  {
    tariffId: string({ maxLength: 60 }),
    statusInfo: StatusInfoSchema,
  },
);
export type ClearTariffsResultType = Infer<typeof ClearTariffsResultSchema>;
export const EVSESchema = cls(
  {
    id: integer({ minimum: 0 }),
  },
  {
    connectorId: integer({ minimum: 0 }),
  },
);
export type EVSEType = Infer<typeof EVSESchema>;
export const ComponentSchema = cls(
  {
    name: string({ maxLength: 50 }),
  },
  {
    instance: string({ maxLength: 50 }),
    evse: EVSESchema,
  },
);
export type ComponentType = Infer<typeof ComponentSchema>;
export const VariableSchema = cls(
  {
    name: string({ maxLength: 50 }),
  },
  {
    instance: string({ maxLength: 50 }),
  },
);
export type VariableType = Infer<typeof VariableSchema>;
export const ComponentVariableSchema = cls(
  {
    component: ComponentSchema,
  },
  {
    variable: VariableSchema,
  },
);
export type ComponentVariableType = Infer<typeof ComponentVariableSchema>;
export const CompositeScheduleSchema = cls({
  evseId: integer({ minimum: 0 }),
  duration: integer(),
  scheduleStart: dateTime(),
  chargingRateUnit: ChargingRateUnitEnumSchema,
  chargingSchedulePeriod: array(ChargingSchedulePeriodSchema, { minItems: 1 }),
});
export type CompositeScheduleType = Infer<typeof CompositeScheduleSchema>;
export const PeriodicEventStreamParamsSchema = cls(
  {},
  {
    interval: integer({ minimum: 0 }),
    values: integer({ minimum: 0 }),
  },
);
export type PeriodicEventStreamParamsType = Infer<typeof PeriodicEventStreamParamsSchema>;
export const ConstantStreamDataSchema = cls({
  id: integer({ minimum: 0 }),
  variableMonitoringId: integer({ minimum: 0 }),
  params: PeriodicEventStreamParamsSchema,
});
export type ConstantStreamDataType = Infer<typeof ConstantStreamDataSchema>;
export const TaxRateSchema = cls(
  {
    type: string({ maxLength: 20 }),
    tax: number(),
  },
  {
    stack: integer({ minimum: 0 }),
  },
);
export type TaxRateType = Infer<typeof TaxRateSchema>;
export const PriceSchema = cls(
  {},
  {
    exclTax: number(),
    inclTax: number(),
    taxRates: array(TaxRateSchema, { minItems: 1, maxItems: 5 }),
  },
);
export type PriceType = Infer<typeof PriceSchema>;
export const TotalPriceSchema = cls(
  {},
  {
    exclTax: number(),
    inclTax: number(),
  },
);
export type TotalPriceType = Infer<typeof TotalPriceSchema>;
export const TotalCostSchema = cls(
  {
    currency: string({ maxLength: 3 }),
    typeOfCost: TariffCostEnumSchema,
    total: TotalPriceSchema,
  },
  {
    fixed: PriceSchema,
    energy: PriceSchema,
    chargingTime: PriceSchema,
    idleTime: PriceSchema,
    reservationTime: PriceSchema,
    reservationFixed: PriceSchema,
  },
);
export type TotalCostType = Infer<typeof TotalCostSchema>;
export const TotalUsageSchema = cls(
  {
    energy: number(),
    chargingTime: integer(),
    idleTime: integer(),
  },
  {
    reservationTime: integer(),
  },
);
export type TotalUsageType = Infer<typeof TotalUsageSchema>;
export const CostDetailsSchema = cls(
  {
    totalCost: TotalCostSchema,
    totalUsage: TotalUsageSchema,
  },
  {
    failureToCalculate: boolean(),
    failureReason: string({ maxLength: 500 }),
    chargingPeriods: array(ChargingPeriodSchema, { minItems: 1 }),
  },
);
export type CostDetailsType = Infer<typeof CostDetailsSchema>;
export const DERCurvePointsSchema = cls({
  x: number(),
  y: number(),
});
export type DERCurvePointsType = Infer<typeof DERCurvePointsSchema>;
export const HysteresisSchema = cls(
  {},
  {
    hysteresisHigh: number(),
    hysteresisLow: number(),
    hysteresisDelay: number(),
    hysteresisGradient: number(),
  },
);
export type HysteresisType = Infer<typeof HysteresisSchema>;
export const ReactivePowerParamsSchema = cls(
  {},
  {
    vRef: number(),
    autonomousVRefEnable: boolean(),
    autonomousVRefTimeConstant: number(),
  },
);
export type ReactivePowerParamsType = Infer<typeof ReactivePowerParamsSchema>;
export const VoltageParamsSchema = cls(
  {},
  {
    hv10MinMeanValue: number(),
    hv10MinMeanTripDelay: number(),
    powerDuringCessation: PowerDuringCessationEnumSchema,
  },
);
export type VoltageParamsType = Infer<typeof VoltageParamsSchema>;
export const DERCurveSchema = cls(
  {
    priority: integer({ minimum: 0 }),
    yUnit: DERUnitEnumSchema,
    curveData: array(DERCurvePointsSchema, { minItems: 1, maxItems: 10 }),
  },
  {
    responseTime: number(),
    startTime: dateTime(),
    duration: number(),
    hysteresis: HysteresisSchema,
    voltageParams: VoltageParamsSchema,
    reactivePowerParams: ReactivePowerParamsSchema,
  },
);
export type DERCurveType = Infer<typeof DERCurveSchema>;
export const DERCurveGetSchema = cls({
  id: string({ maxLength: 36 }),
  curveType: DERControlEnumSchema,
  isDefault: boolean(),
  isSuperseded: boolean(),
  curve: DERCurveSchema,
});
export type DERCurveGetType = Infer<typeof DERCurveGetSchema>;
export const EnterServiceSchema = cls(
  {
    priority: integer({ minimum: 0 }),
    highVoltage: number(),
    lowVoltage: number(),
    highFreq: number(),
    lowFreq: number(),
  },
  {
    delay: number(),
    randomDelay: number(),
    rampRate: number(),
  },
);
export type EnterServiceType = Infer<typeof EnterServiceSchema>;
export const EnterServiceGetSchema = cls({
  id: string({ maxLength: 36 }),
  enterService: EnterServiceSchema,
});
export type EnterServiceGetType = Infer<typeof EnterServiceGetSchema>;
export const EventDataSchema = cls(
  {
    eventId: integer({ minimum: 0 }),
    timestamp: dateTime(),
    trigger: EventTriggerEnumSchema,
    actualValue: string({ maxLength: 2500 }),
    eventNotificationType: EventNotificationEnumSchema,
    component: ComponentSchema,
    variable: VariableSchema,
  },
  {
    cause: integer({ minimum: 0 }),
    techCode: string({ maxLength: 50 }),
    techInfo: string({ maxLength: 500 }),
    cleared: boolean(),
    transactionId: string({ maxLength: 36 }),
    variableMonitoringId: integer({ minimum: 0 }),
    severity: integer({ minimum: 0 }),
  },
);
export type EventDataType = Infer<typeof EventDataSchema>;
export const FirmwareSchema = cls(
  {
    location: string({ maxLength: 2000 }),
    retrieveDateTime: dateTime(),
  },
  {
    installDateTime: dateTime(),
    signingCertificate: string({ maxLength: 5500 }),
    signature: string({ maxLength: 800 }),
  },
);
export type FirmwareType = Infer<typeof FirmwareSchema>;
export const FixedPFSchema = cls(
  {
    priority: integer({ minimum: 0 }),
    displacement: number(),
    excitation: boolean(),
  },
  {
    startTime: dateTime(),
    duration: number(),
  },
);
export type FixedPFType = Infer<typeof FixedPFSchema>;
export const FixedPFGetSchema = cls({
  id: string({ maxLength: 36 }),
  isDefault: boolean(),
  isSuperseded: boolean(),
  fixedPF: FixedPFSchema,
});
export type FixedPFGetType = Infer<typeof FixedPFGetSchema>;
export const FixedVarSchema = cls(
  {
    priority: integer({ minimum: 0 }),
    setpoint: number(),
    unit: DERUnitEnumSchema,
  },
  {
    startTime: dateTime(),
    duration: number(),
  },
);
export type FixedVarType = Infer<typeof FixedVarSchema>;
export const FixedVarGetSchema = cls({
  id: string({ maxLength: 36 }),
  isDefault: boolean(),
  isSuperseded: boolean(),
  fixedVar: FixedVarSchema,
});
export type FixedVarGetType = Infer<typeof FixedVarGetSchema>;
export const FreqDroopSchema = cls(
  {
    priority: integer({ minimum: 0 }),
    overFreq: number(),
    underFreq: number(),
    overDroop: number(),
    underDroop: number(),
    responseTime: number(),
  },
  {
    startTime: dateTime(),
    duration: number(),
  },
);
export type FreqDroopType = Infer<typeof FreqDroopSchema>;
export const FreqDroopGetSchema = cls({
  id: string({ maxLength: 36 }),
  isDefault: boolean(),
  isSuperseded: boolean(),
  freqDroop: FreqDroopSchema,
});
export type FreqDroopGetType = Infer<typeof FreqDroopGetSchema>;
export const GetVariableDataSchema = cls(
  {
    component: ComponentSchema,
    variable: VariableSchema,
  },
  {
    attributeType: AttributeEnumSchema,
  },
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
export const GradientSchema = cls({
  priority: integer({ minimum: 0 }),
  gradient: number(),
  softGradient: number(),
});
export type GradientType = Infer<typeof GradientSchema>;
export const GradientGetSchema = cls({
  id: string({ maxLength: 36 }),
  gradient: GradientSchema,
});
export type GradientGetType = Infer<typeof GradientGetSchema>;
export const LimitMaxDischargeSchema = cls(
  {
    priority: integer({ minimum: 0 }),
  },
  {
    pctMaxDischargePower: number(),
    startTime: dateTime(),
    duration: number(),
    powerMonitoringMustTrip: DERCurveSchema,
  },
);
export type LimitMaxDischargeType = Infer<typeof LimitMaxDischargeSchema>;
export const LimitMaxDischargeGetSchema = cls({
  id: string({ maxLength: 36 }),
  isDefault: boolean(),
  isSuperseded: boolean(),
  limitMaxDischarge: LimitMaxDischargeSchema,
});
export type LimitMaxDischargeGetType = Infer<typeof LimitMaxDischargeGetSchema>;
export const LogParametersSchema = cls(
  {
    remoteLocation: string({ maxLength: 2000 }),
  },
  {
    oldestTimestamp: dateTime(),
    latestTimestamp: dateTime(),
  },
);
export type LogParametersType = Infer<typeof LogParametersSchema>;
export const MessageInfoSchema = cls(
  {
    id: integer({ minimum: 0 }),
    priority: MessagePriorityEnumSchema,
    message: MessageContentSchema,
  },
  {
    state: MessageStateEnumSchema,
    startDateTime: dateTime(),
    endDateTime: dateTime(),
    transactionId: string({ maxLength: 36 }),
    display: ComponentSchema,
    messageExtra: array(MessageContentSchema, { minItems: 1, maxItems: 4 }),
  },
);
export type MessageInfoType = Infer<typeof MessageInfoSchema>;
export const SignedMeterValueSchema = cls(
  {
    signedMeterData: string({ maxLength: 32768 }),
    encodingMethod: string({ maxLength: 50 }),
  },
  {
    signingMethod: string({ maxLength: 50 }),
    publicKey: string({ maxLength: 2500 }),
  },
);
export type SignedMeterValueType = Infer<typeof SignedMeterValueSchema>;
export const UnitOfMeasureSchema = cls(
  {},
  {
    unit: string({ maxLength: 20 }),
    multiplier: integer(),
  },
);
export type UnitOfMeasureType = Infer<typeof UnitOfMeasureSchema>;
export const SampledValueSchema = cls(
  {
    value: number(),
  },
  {
    measurand: MeasurandEnumSchema,
    context: ReadingContextEnumSchema,
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
  id: integer({ minimum: 0 }),
  transaction: boolean(),
  value: number(),
  type: MonitorEnumSchema,
  severity: integer({ minimum: 0 }),
  eventNotificationType: EventNotificationEnumSchema,
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
    server: string({ maxLength: 2000 }),
    user: string({ maxLength: 50 }),
    password: string({ maxLength: 64 }),
    key: string({ maxLength: 255 }),
    type: VPNEnumSchema,
  },
  {
    group: string({ maxLength: 50 }),
  },
);
export type VPNType = Infer<typeof VPNSchema>;
export const NetworkConnectionProfileSchema = cls(
  {
    ocppInterface: OCPPInterfaceEnumSchema,
    ocppTransport: OCPPTransportEnumSchema,
    messageTimeout: integer(),
    ocppCsmsUrl: string({ maxLength: 2000 }),
    securityProfile: integer({ minimum: 0 }),
  },
  {
    ocppVersion: OCPPVersionEnumSchema,
    identity: string({ maxLength: 48 }),
    basicAuthPassword: string({ maxLength: 64 }),
    vpn: VPNSchema,
    apn: APNSchema,
  },
);
export type NetworkConnectionProfileType = Infer<typeof NetworkConnectionProfileSchema>;
export const OCSPRequestDataSchema = cls({
  hashAlgorithm: HashAlgorithmEnumSchema,
  issuerNameHash: string({ maxLength: 128 }),
  issuerKeyHash: string({ maxLength: 128 }),
  serialNumber: string({ maxLength: 40 }),
  responderURL: string({ maxLength: 2000 }),
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
  {
    dataType: DataEnumSchema,
    supportsMonitoring: boolean(),
  },
  {
    unit: string({ maxLength: 16 }),
    minLimit: number(),
    maxLimit: number(),
    maxElements: integer({ minimum: 1 }),
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
  {
    variableCharacteristics: VariableCharacteristicsSchema,
  },
);
export type ReportDataType = Infer<typeof ReportDataSchema>;
export const SetMonitoringDataSchema = cls(
  {
    value: number(),
    type: MonitorEnumSchema,
    severity: integer({ minimum: 0 }),
    component: ComponentSchema,
    variable: VariableSchema,
  },
  {
    id: integer({ minimum: 0 }),
    transaction: boolean(),
    periodicEventStream: PeriodicEventStreamParamsSchema,
  },
);
export type SetMonitoringDataType = Infer<typeof SetMonitoringDataSchema>;
export const SetMonitoringResultSchema = cls(
  {
    status: SetMonitoringStatusEnumSchema,
    type: MonitorEnumSchema,
    severity: integer({ minimum: 0 }),
    component: ComponentSchema,
    variable: VariableSchema,
  },
  {
    id: integer({ minimum: 0 }),
    statusInfo: StatusInfoSchema,
  },
);
export type SetMonitoringResultType = Infer<typeof SetMonitoringResultSchema>;
export const SetVariableDataSchema = cls(
  {
    attributeValue: string({ maxLength: 2500 }),
    component: ComponentSchema,
    variable: VariableSchema,
  },
  {
    attributeType: AttributeEnumSchema,
  },
);
export type SetVariableDataType = Infer<typeof SetVariableDataSchema>;
export const SetVariableResultSchema = cls(
  {
    attributeStatus: SetVariableStatusEnumSchema,
    component: ComponentSchema,
    variable: VariableSchema,
  },
  {
    attributeType: AttributeEnumSchema,
    attributeStatusInfo: StatusInfoSchema,
  },
);
export type SetVariableResultType = Infer<typeof SetVariableResultSchema>;
export const StreamDataElementSchema = cls({
  t: number(),
  v: string({ maxLength: 2500 }),
});
export type StreamDataElementType = Infer<typeof StreamDataElementSchema>;
export const TariffAssignmentSchema = cls(
  {
    tariffId: string({ maxLength: 60 }),
    tariffKind: TariffKindEnumSchema,
  },
  {
    validFrom: dateTime(),
    evseIds: array(integer({ minimum: 0 }), { minItems: 1 }),
    idTokens: array(string({ maxLength: 255 }), { minItems: 1 }),
  },
);
export type TariffAssignmentType = Infer<typeof TariffAssignmentSchema>;
export const TariffConditionsFixedSchema = cls(
  {},
  {
    startTimeOfDay: string(),
    endTimeOfDay: string(),
    dayOfWeek: array(DayOfWeekEnumSchema, { minItems: 1, maxItems: 7 }),
    validFromDate: string(),
    validToDate: string(),
    evseKind: EvseKindEnumSchema,
    paymentBrand: string({ maxLength: 20 }),
    paymentRecognition: string({ maxLength: 20 }),
  },
);
export type TariffConditionsFixedType = Infer<typeof TariffConditionsFixedSchema>;
export const TariffConditionsSchema = cls(
  {},
  {
    startTimeOfDay: string(),
    endTimeOfDay: string(),
    dayOfWeek: array(DayOfWeekEnumSchema, { minItems: 1, maxItems: 7 }),
    validFromDate: string(),
    validToDate: string(),
    evseKind: EvseKindEnumSchema,
    minEnergy: number(),
    maxEnergy: number(),
    minCurrent: number(),
    maxCurrent: number(),
    minPower: number(),
    maxPower: number(),
    minTime: integer(),
    maxTime: integer(),
    minChargingTime: integer(),
    maxChargingTime: integer(),
    minIdleTime: integer(),
    maxIdleTime: integer(),
  },
);
export type TariffConditionsType = Infer<typeof TariffConditionsSchema>;
export const TariffEnergyPriceSchema = cls(
  {
    priceKwh: number(),
  },
  {
    conditions: TariffConditionsSchema,
  },
);
export type TariffEnergyPriceType = Infer<typeof TariffEnergyPriceSchema>;
export const TariffEnergySchema = cls(
  {
    prices: array(TariffEnergyPriceSchema, { minItems: 1 }),
  },
  {
    taxRates: array(TaxRateSchema, { minItems: 1, maxItems: 5 }),
  },
);
export type TariffEnergyType = Infer<typeof TariffEnergySchema>;
export const TariffFixedPriceSchema = cls(
  {
    priceFixed: number(),
  },
  {
    conditions: TariffConditionsFixedSchema,
  },
);
export type TariffFixedPriceType = Infer<typeof TariffFixedPriceSchema>;
export const TariffFixedSchema = cls(
  {
    prices: array(TariffFixedPriceSchema, { minItems: 1 }),
  },
  {
    taxRates: array(TaxRateSchema, { minItems: 1, maxItems: 5 }),
  },
);
export type TariffFixedType = Infer<typeof TariffFixedSchema>;
export const TariffTimePriceSchema = cls(
  {
    priceMinute: number(),
  },
  {
    conditions: TariffConditionsSchema,
  },
);
export type TariffTimePriceType = Infer<typeof TariffTimePriceSchema>;
export const TariffTimeSchema = cls(
  {
    prices: array(TariffTimePriceSchema, { minItems: 1 }),
  },
  {
    taxRates: array(TaxRateSchema, { minItems: 1, maxItems: 5 }),
  },
);
export type TariffTimeType = Infer<typeof TariffTimeSchema>;
export const TariffSchema = cls(
  {
    tariffId: string({ maxLength: 60 }),
    currency: string({ maxLength: 3 }),
  },
  {
    validFrom: dateTime(),
    description: array(MessageContentSchema, { minItems: 1, maxItems: 10 }),
    energy: TariffEnergySchema,
    chargingTime: TariffTimeSchema,
    idleTime: TariffTimeSchema,
    fixedFee: TariffFixedSchema,
    minCost: PriceSchema,
    maxCost: PriceSchema,
    reservationTime: TariffTimeSchema,
    reservationFixed: TariffFixedSchema,
  },
);
export type TariffType = Infer<typeof TariffSchema>;
export const TransactionLimitSchema = cls(
  {},
  {
    maxCost: number(),
    maxEnergy: number(),
    maxTime: integer(),
    maxSoC: integer({ minimum: 0, maximum: 100 }),
  },
);
export type TransactionLimitType = Infer<typeof TransactionLimitSchema>;
export const TransactionSchema = cls(
  {
    transactionId: string({ maxLength: 36 }),
  },
  {
    chargingState: ChargingStateEnumSchema,
    timeSpentCharging: integer(),
    stoppedReason: ReasonEnumSchema,
    remoteStartId: integer(),
    operationMode: OperationModeEnumSchema,
    tariffId: string({ maxLength: 60 }),
    transactionLimit: TransactionLimitSchema,
  },
);
export type TransactionType = Infer<typeof TransactionSchema>;

// ---- Messages (Part 2, chapter 1) ---------------------------------------

export const OCPP21_MESSAGES = {
  AFRRSignal: {
    request: cls({
      timestamp: dateTime(),
      signal: integer(),
    }),
    response: cls(
      {
        status: GenericStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  AdjustPeriodicEventStream: {
    request: cls({
      id: integer({ minimum: 0 }),
      params: PeriodicEventStreamParamsSchema,
    }),
    response: cls(
      {
        status: GenericStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  Authorize: {
    request: cls(
      {
        idToken: IdTokenSchema,
      },
      {
        certificate: string({ maxLength: 10000 }),
        iso15118CertificateHashData: array(OCSPRequestDataSchema, { minItems: 1, maxItems: 4 }),
      },
    ),
    response: cls(
      {
        idTokenInfo: IdTokenInfoSchema,
      },
      {
        certificateStatus: AuthorizeCertificateStatusEnumSchema,
        allowedEnergyTransfer: array(EnergyTransferModeEnumSchema, { minItems: 1 }),
        tariff: TariffSchema,
      },
    ),
  },
  BatterySwap: {
    request: cls({
      eventType: BatterySwapEventEnumSchema,
      requestId: integer(),
      idToken: IdTokenSchema,
      batteryData: array(BatteryDataSchema, { minItems: 1 }),
    }),
    response: cls({}),
  },
  BootNotification: {
    request: cls({
      reason: BootReasonEnumSchema,
      chargingStation: ChargingStationSchema,
    }),
    response: cls(
      {
        currentTime: dateTime(),
        interval: integer(),
        status: RegistrationStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  CancelReservation: {
    request: cls({
      reservationId: integer({ minimum: 0 }),
    }),
    response: cls(
      {
        status: CancelReservationStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  CertificateSigned: {
    request: cls(
      {
        certificateChain: string({ maxLength: 10000 }),
      },
      {
        certificateType: CertificateSigningUseEnumSchema,
        requestId: integer(),
      },
    ),
    response: cls(
      {
        status: CertificateSignedStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  ChangeAvailability: {
    request: cls(
      {
        operationalStatus: OperationalStatusEnumSchema,
      },
      {
        evse: EVSESchema,
      },
    ),
    response: cls(
      {
        status: ChangeAvailabilityStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  ChangeTransactionTariff: {
    request: cls({
      transactionId: string({ maxLength: 36 }),
      tariff: TariffSchema,
    }),
    response: cls(
      {
        status: TariffChangeStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  ClearCache: {
    request: cls({}),
    response: cls(
      {
        status: ClearCacheStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  ClearChargingProfile: {
    request: cls(
      {},
      {
        chargingProfileId: integer(),
        chargingProfileCriteria: ClearChargingProfileSchema,
      },
    ),
    response: cls(
      {
        status: ClearChargingProfileStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  ClearDERControl: {
    request: cls(
      {
        isDefault: boolean(),
      },
      {
        controlType: DERControlEnumSchema,
        controlId: string({ maxLength: 36 }),
      },
    ),
    response: cls(
      {
        status: DERControlStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  ClearDisplayMessage: {
    request: cls({
      id: integer({ minimum: 0 }),
    }),
    response: cls(
      {
        status: ClearMessageStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  ClearTariffs: {
    request: cls(
      {},
      {
        tariffIds: array(string({ maxLength: 60 }), { minItems: 1 }),
        evseId: integer({ minimum: 0 }),
      },
    ),
    response: cls({
      clearTariffsResult: array(ClearTariffsResultSchema, { minItems: 1 }),
    }),
  },
  ClearVariableMonitoring: {
    request: cls({
      id: array(integer({ minimum: 0 }), { minItems: 1 }),
    }),
    response: cls({
      clearMonitoringResult: array(ClearMonitoringResultSchema, { minItems: 1 }),
    }),
  },
  ClearedChargingLimit: {
    request: cls(
      {
        chargingLimitSource: string({ maxLength: 20 }),
      },
      {
        evseId: integer({ minimum: 0 }),
      },
    ),
    response: cls({}),
  },
  ClosePeriodicEventStream: {
    request: cls({
      id: integer({ minimum: 0 }),
    }),
    response: cls({}),
  },
  CostUpdated: {
    request: cls({
      totalCost: number(),
      transactionId: string({ maxLength: 36 }),
    }),
    response: cls({}),
  },
  CustomerInformation: {
    request: cls(
      {
        requestId: integer({ minimum: 0 }),
        report: boolean(),
        clear: boolean(),
      },
      {
        customerIdentifier: string({ maxLength: 64 }),
        idToken: IdTokenSchema,
        customerCertificate: CertificateHashDataSchema,
      },
    ),
    response: cls(
      {
        status: CustomerInformationStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  DataTransfer: {
    request: cls(
      {
        vendorId: string({ maxLength: 255 }),
      },
      {
        messageId: string({ maxLength: 50 }),
        data: anyValue(),
      },
    ),
    response: cls(
      {
        status: DataTransferStatusEnumSchema,
      },
      {
        data: anyValue(),
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  DeleteCertificate: {
    request: cls({
      certificateHashData: CertificateHashDataSchema,
    }),
    response: cls(
      {
        status: DeleteCertificateStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  FirmwareStatusNotification: {
    request: cls(
      {
        status: FirmwareStatusEnumSchema,
      },
      {
        requestId: integer(),
        statusInfo: StatusInfoSchema,
      },
    ),
    response: cls({}),
  },
  Get15118EVCertificate: {
    request: cls(
      {
        iso15118SchemaVersion: string({ maxLength: 50 }),
        action: CertificateActionEnumSchema,
        exiRequest: string({ maxLength: 11000 }),
      },
      {
        maximumContractCertificateChains: integer({ minimum: 0 }),
        prioritizedEMAIDs: array(string({ maxLength: 255 }), { minItems: 1, maxItems: 8 }),
      },
    ),
    response: cls(
      {
        status: Iso15118EVCertificateStatusEnumSchema,
        exiResponse: string({ maxLength: 17000 }),
      },
      {
        remainingContracts: integer({ minimum: 0 }),
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  GetBaseReport: {
    request: cls({
      requestId: integer(),
      reportBase: ReportBaseEnumSchema,
    }),
    response: cls(
      {
        status: GenericDeviceModelStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  GetCertificateChainStatus: {
    request: cls({
      certificateStatusRequests: array(CertificateStatusRequestInfoSchema, {
        minItems: 1,
        maxItems: 4,
      }),
    }),
    response: cls({
      certificateStatus: array(CertificateStatusSchema, { minItems: 1, maxItems: 4 }),
    }),
  },
  GetCertificateStatus: {
    request: cls({
      ocspRequestData: OCSPRequestDataSchema,
    }),
    response: cls(
      {
        status: GetCertificateStatusEnumSchema,
      },
      {
        ocspResult: string({ maxLength: 18000 }),
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  GetChargingProfiles: {
    request: cls(
      {
        requestId: integer(),
        chargingProfile: ChargingProfileCriterionSchema,
      },
      {
        evseId: integer({ minimum: 0 }),
      },
    ),
    response: cls(
      {
        status: GetChargingProfileStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  GetCompositeSchedule: {
    request: cls(
      {
        duration: integer(),
        evseId: integer({ minimum: 0 }),
      },
      {
        chargingRateUnit: ChargingRateUnitEnumSchema,
      },
    ),
    response: cls(
      {
        status: GenericStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
        schedule: CompositeScheduleSchema,
      },
    ),
  },
  GetDERControl: {
    request: cls(
      {
        requestId: integer(),
      },
      {
        isDefault: boolean(),
        controlType: DERControlEnumSchema,
        controlId: string({ maxLength: 36 }),
      },
    ),
    response: cls(
      {
        status: DERControlStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  GetDisplayMessages: {
    request: cls(
      {
        requestId: integer(),
      },
      {
        id: array(integer({ minimum: 0 }), { minItems: 1 }),
        priority: MessagePriorityEnumSchema,
        state: MessageStateEnumSchema,
      },
    ),
    response: cls(
      {
        status: GetDisplayMessagesStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  GetInstalledCertificateIds: {
    request: cls(
      {},
      {
        certificateType: array(GetCertificateIdUseEnumSchema, { minItems: 1 }),
      },
    ),
    response: cls(
      {
        status: GetInstalledCertificateStatusEnumSchema,
      },
      {
        certificateHashDataChain: array(CertificateHashDataChainSchema, { minItems: 1 }),
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  GetLocalListVersion: {
    request: cls({}),
    response: cls({
      versionNumber: integer(),
    }),
  },
  GetLog: {
    request: cls(
      {
        logType: LogEnumSchema,
        requestId: integer(),
        log: LogParametersSchema,
      },
      {
        retries: integer({ minimum: 0 }),
        retryInterval: integer(),
      },
    ),
    response: cls(
      {
        status: LogStatusEnumSchema,
      },
      {
        filename: string({ maxLength: 255 }),
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  GetMonitoringReport: {
    request: cls(
      {
        requestId: integer(),
      },
      {
        monitoringCriteria: array(MonitoringCriterionEnumSchema, { minItems: 1, maxItems: 3 }),
        componentVariable: array(ComponentVariableSchema, { minItems: 1 }),
      },
    ),
    response: cls(
      {
        status: GenericDeviceModelStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  GetPeriodicEventStream: {
    request: cls({}),
    response: cls(
      {},
      {
        constantStreamData: array(ConstantStreamDataSchema, { minItems: 1 }),
      },
    ),
  },
  GetReport: {
    request: cls(
      {
        requestId: integer(),
      },
      {
        componentCriteria: array(ComponentCriterionEnumSchema, { minItems: 1, maxItems: 4 }),
        componentVariable: array(ComponentVariableSchema, { minItems: 1 }),
      },
    ),
    response: cls(
      {
        status: GenericDeviceModelStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  GetTariffs: {
    request: cls({
      evseId: integer({ minimum: 0 }),
    }),
    response: cls(
      {
        status: TariffGetStatusEnumSchema,
      },
      {
        tariffAssignments: array(TariffAssignmentSchema, { minItems: 1 }),
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  GetTransactionStatus: {
    request: cls(
      {},
      {
        transactionId: string({ maxLength: 36 }),
      },
    ),
    response: cls(
      {
        messagesInQueue: boolean(),
      },
      {
        ongoingIndicator: boolean(),
      },
    ),
  },
  GetVariables: {
    request: cls({
      getVariableData: array(GetVariableDataSchema, { minItems: 1 }),
    }),
    response: cls({
      getVariableResult: array(GetVariableResultSchema, { minItems: 1 }),
    }),
  },
  Heartbeat: {
    request: cls({}),
    response: cls({
      currentTime: dateTime(),
    }),
  },
  InstallCertificate: {
    request: cls({
      certificateType: InstallCertificateUseEnumSchema,
      certificate: string({ maxLength: 10000 }),
    }),
    response: cls(
      {
        status: InstallCertificateStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  LogStatusNotification: {
    request: cls(
      {
        status: UploadLogStatusEnumSchema,
      },
      {
        requestId: integer(),
        statusInfo: StatusInfoSchema,
      },
    ),
    response: cls({}),
  },
  MeterValues: {
    request: cls({
      evseId: integer({ minimum: 0 }),
      meterValue: array(MeterValueSchema, { minItems: 1 }),
    }),
    response: cls({}),
  },
  NotifyAllowedEnergyTransfer: {
    request: cls({
      transactionId: string({ maxLength: 36 }),
      allowedEnergyTransfer: array(EnergyTransferModeEnumSchema, { minItems: 1 }),
    }),
    response: cls(
      {
        status: NotifyAllowedEnergyTransferStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  NotifyChargingLimit: {
    request: cls(
      {
        chargingLimit: ChargingLimitSchema,
      },
      {
        evseId: integer({ minimum: 0 }),
        chargingSchedule: array(ChargingScheduleSchema, { minItems: 1 }),
      },
    ),
    response: cls({}),
  },
  NotifyCustomerInformation: {
    request: cls(
      {
        data: string({ maxLength: 512 }),
        seqNo: integer({ minimum: 0 }),
        generatedAt: dateTime(),
        requestId: integer({ minimum: 0 }),
      },
      {
        tbc: boolean(),
      },
    ),
    response: cls({}),
  },
  NotifyDERAlarm: {
    request: cls(
      {
        controlType: DERControlEnumSchema,
        timestamp: dateTime(),
      },
      {
        gridEventFault: GridEventFaultEnumSchema,
        alarmEnded: boolean(),
        extraInfo: string({ maxLength: 200 }),
      },
    ),
    response: cls({}),
  },
  NotifyDERStartStop: {
    request: cls(
      {
        controlId: string({ maxLength: 36 }),
        started: boolean(),
        timestamp: dateTime(),
      },
      {
        supersededIds: array(string({ maxLength: 36 }), { minItems: 1, maxItems: 24 }),
      },
    ),
    response: cls({}),
  },
  NotifyDisplayMessages: {
    request: cls(
      {
        requestId: integer(),
      },
      {
        tbc: boolean(),
        messageInfo: array(MessageInfoSchema, { minItems: 1 }),
      },
    ),
    response: cls({}),
  },
  NotifyEVChargingNeeds: {
    request: cls(
      {
        evseId: integer({ minimum: 1 }),
        chargingNeeds: ChargingNeedsSchema,
      },
      {
        maxScheduleTuples: integer({ minimum: 0 }),
        timestamp: dateTime(),
      },
    ),
    response: cls(
      {
        status: NotifyEVChargingNeedsStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  NotifyEVChargingSchedule: {
    request: cls(
      {
        timeBase: dateTime(),
        evseId: integer({ minimum: 1 }),
        chargingSchedule: ChargingScheduleSchema,
      },
      {
        selectedChargingScheduleId: integer({ minimum: 0 }),
        powerToleranceAcceptance: boolean(),
      },
    ),
    response: cls(
      {
        status: GenericStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  NotifyEvent: {
    request: cls(
      {
        generatedAt: dateTime(),
        seqNo: integer({ minimum: 0 }),
        eventData: array(EventDataSchema, { minItems: 1 }),
      },
      {
        tbc: boolean(),
      },
    ),
    response: cls({}),
  },
  NotifyMonitoringReport: {
    request: cls(
      {
        requestId: integer(),
        seqNo: integer({ minimum: 0 }),
        generatedAt: dateTime(),
      },
      {
        tbc: boolean(),
        monitor: array(MonitoringDataSchema, { minItems: 1 }),
      },
    ),
    response: cls({}),
  },
  NotifyPeriodicEventStream: {
    request: cls({
      id: integer({ minimum: 0 }),
      pending: integer({ minimum: 0 }),
      basetime: dateTime(),
      data: array(StreamDataElementSchema, { minItems: 1 }),
    }),
    /** A SEND message (Part 4): it has no response. */
    response: undefined,
  },
  NotifyPriorityCharging: {
    request: cls({
      transactionId: string({ maxLength: 36 }),
      activated: boolean(),
    }),
    response: cls({}),
  },
  NotifyReport: {
    request: cls(
      {
        requestId: integer(),
        generatedAt: dateTime(),
        seqNo: integer({ minimum: 0 }),
      },
      {
        tbc: boolean(),
        reportData: array(ReportDataSchema, { minItems: 1 }),
      },
    ),
    response: cls({}),
  },
  NotifySettlement: {
    request: cls(
      {
        pspRef: string({ maxLength: 255 }),
        status: PaymentStatusEnumSchema,
        settlementAmount: number(),
        settlementTime: dateTime(),
      },
      {
        transactionId: string({ maxLength: 36 }),
        statusInfo: string({ maxLength: 500 }),
        receiptId: string({ maxLength: 50 }),
        receiptUrl: string({ maxLength: 2000 }),
        vatNumber: string({ maxLength: 20 }),
        vatCompany: AddressSchema,
      },
    ),
    response: cls(
      {},
      {
        receiptUrl: string({ maxLength: 2000 }),
        receiptId: string({ maxLength: 50 }),
      },
    ),
  },
  NotifyWebPaymentStarted: {
    request: cls({
      evseId: integer({ minimum: 0 }),
      timeout: integer(),
    }),
    response: cls({}),
  },
  OpenPeriodicEventStream: {
    request: cls({
      constantStreamData: ConstantStreamDataSchema,
    }),
    response: cls(
      {
        status: GenericStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  PublishFirmware: {
    request: cls(
      {
        location: string({ maxLength: 2000 }),
        checksum: string({ maxLength: 32 }),
        requestId: integer({ minimum: 0 }),
      },
      {
        retries: integer({ minimum: 0 }),
        retryInterval: integer({ minimum: 0 }),
      },
    ),
    response: cls(
      {
        status: GenericStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  PublishFirmwareStatusNotification: {
    request: cls(
      {
        status: PublishFirmwareStatusEnumSchema,
      },
      {
        location: array(string({ maxLength: 2000 }), { minItems: 1 }),
        requestId: integer({ minimum: 0 }),
        statusInfo: StatusInfoSchema,
      },
    ),
    response: cls({}),
  },
  PullDynamicScheduleUpdate: {
    request: cls({
      chargingProfileId: integer(),
    }),
    response: cls(
      {
        status: ChargingProfileStatusEnumSchema,
      },
      {
        scheduleUpdate: ChargingScheduleUpdateSchema,
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  ReportChargingProfiles: {
    request: cls(
      {
        requestId: integer(),
        chargingLimitSource: string({ maxLength: 20 }),
        evseId: integer({ minimum: 0 }),
        chargingProfile: array(ChargingProfileSchema, { minItems: 1 }),
      },
      {
        tbc: boolean(),
      },
    ),
    response: cls({}),
  },
  ReportDERControl: {
    request: cls(
      {
        requestId: integer(),
      },
      {
        tbc: boolean(),
        fixedPFAbsorb: array(FixedPFGetSchema, { minItems: 1, maxItems: 24 }),
        fixedPFInject: array(FixedPFGetSchema, { minItems: 1, maxItems: 24 }),
        fixedVar: array(FixedVarGetSchema, { minItems: 1, maxItems: 24 }),
        limitMaxDischarge: array(LimitMaxDischargeGetSchema, { minItems: 1, maxItems: 24 }),
        freqDroop: array(FreqDroopGetSchema, { minItems: 1, maxItems: 24 }),
        enterService: array(EnterServiceGetSchema, { minItems: 1, maxItems: 24 }),
        gradient: array(GradientGetSchema, { minItems: 1, maxItems: 24 }),
        curve: array(DERCurveGetSchema, { minItems: 1, maxItems: 24 }),
      },
    ),
    response: cls({}),
  },
  RequestBatterySwap: {
    request: cls({
      requestId: integer(),
      idToken: IdTokenSchema,
    }),
    response: cls(
      {
        status: GenericStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  RequestStartTransaction: {
    request: cls(
      {
        remoteStartId: integer(),
        idToken: IdTokenSchema,
      },
      {
        evseId: integer({ minimum: 1 }),
        chargingProfile: ChargingProfileSchema,
        groupIdToken: IdTokenSchema,
      },
    ),
    response: cls(
      {
        status: RequestStartStopStatusEnumSchema,
      },
      {
        transactionId: string({ maxLength: 36 }),
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  RequestStopTransaction: {
    request: cls({
      transactionId: string({ maxLength: 36 }),
    }),
    response: cls(
      {
        status: RequestStartStopStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  ReservationStatusUpdate: {
    request: cls({
      reservationId: integer({ minimum: 0 }),
      reservationUpdateStatus: ReservationUpdateStatusEnumSchema,
    }),
    response: cls({}),
  },
  ReserveNow: {
    request: cls(
      {
        id: integer({ minimum: 0 }),
        expiryDateTime: dateTime(),
        idToken: IdTokenSchema,
      },
      {
        connectorType: string({ maxLength: 20 }),
        evseId: integer({ minimum: 0 }),
        groupIdToken: IdTokenSchema,
      },
    ),
    response: cls(
      {
        status: ReserveNowStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  Reset: {
    request: cls(
      {
        type: ResetEnumSchema,
      },
      {
        evseId: integer({ minimum: 0 }),
      },
    ),
    response: cls(
      {
        status: ResetStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  SecurityEventNotification: {
    request: cls(
      {
        type: string({ maxLength: 50 }),
        timestamp: dateTime(),
      },
      {
        techInfo: string({ maxLength: 255 }),
      },
    ),
    response: cls({}),
  },
  SendLocalList: {
    request: cls(
      {
        versionNumber: integer(),
        updateType: UpdateEnumSchema,
      },
      {
        localAuthorizationList: array(AuthorizationDataSchema, { minItems: 1 }),
      },
    ),
    response: cls(
      {
        status: SendLocalListStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  SetChargingProfile: {
    request: cls({
      evseId: integer({ minimum: 0 }),
      chargingProfile: ChargingProfileSchema,
    }),
    response: cls(
      {
        status: ChargingProfileStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  SetDERControl: {
    request: cls(
      {
        isDefault: boolean(),
        controlId: string({ maxLength: 36 }),
        controlType: DERControlEnumSchema,
      },
      {
        curve: DERCurveSchema,
        fixedPFAbsorb: FixedPFSchema,
        fixedPFInject: FixedPFSchema,
        fixedVar: FixedVarSchema,
        limitMaxDischarge: LimitMaxDischargeSchema,
        freqDroop: FreqDroopSchema,
        enterService: EnterServiceSchema,
        gradient: GradientSchema,
      },
    ),
    response: cls(
      {
        status: DERControlStatusEnumSchema,
      },
      {
        supersededIds: array(string({ maxLength: 36 }), { minItems: 1, maxItems: 24 }),
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  SetDefaultTariff: {
    request: cls({
      evseId: integer({ minimum: 0 }),
      tariff: TariffSchema,
    }),
    response: cls(
      {
        status: TariffSetStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  SetDisplayMessage: {
    request: cls({
      message: MessageInfoSchema,
    }),
    response: cls(
      {
        status: DisplayMessageStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  SetMonitoringBase: {
    request: cls({
      monitoringBase: MonitoringBaseEnumSchema,
    }),
    response: cls(
      {
        status: GenericDeviceModelStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  SetMonitoringLevel: {
    request: cls({
      severity: integer({ minimum: 0 }),
    }),
    response: cls(
      {
        status: GenericStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  SetNetworkProfile: {
    request: cls({
      configurationSlot: integer(),
      connectionData: NetworkConnectionProfileSchema,
    }),
    response: cls(
      {
        status: SetNetworkProfileStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  SetVariableMonitoring: {
    request: cls({
      setMonitoringData: array(SetMonitoringDataSchema, { minItems: 1 }),
    }),
    response: cls({
      setMonitoringResult: array(SetMonitoringResultSchema, { minItems: 1 }),
    }),
  },
  SetVariables: {
    request: cls({
      setVariableData: array(SetVariableDataSchema, { minItems: 1 }),
    }),
    response: cls({
      setVariableResult: array(SetVariableResultSchema, { minItems: 1 }),
    }),
  },
  SignCertificate: {
    request: cls(
      {
        csr: string({ maxLength: 5500 }),
      },
      {
        certificateType: CertificateSigningUseEnumSchema,
        requestId: integer(),
        hashRootCertificate: CertificateHashDataSchema,
      },
    ),
    response: cls(
      {
        status: GenericStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  StatusNotification: {
    request: cls({
      timestamp: dateTime(),
      connectorStatus: ConnectorStatusEnumSchema,
      evseId: integer({ minimum: 0 }),
      connectorId: integer({ minimum: 0 }),
    }),
    response: cls({}),
  },
  TransactionEvent: {
    request: cls(
      {
        eventType: TransactionEventEnumSchema,
        timestamp: dateTime(),
        triggerReason: TriggerReasonEnumSchema,
        seqNo: integer({ minimum: 0 }),
        transactionInfo: TransactionSchema,
      },
      {
        offline: boolean(),
        numberOfPhasesUsed: integer({ minimum: 0, maximum: 3 }),
        cableMaxCurrent: integer(),
        reservationId: integer({ minimum: 0 }),
        preconditioningStatus: PreconditioningStatusEnumSchema,
        evseSleep: boolean(),
        meterValue: array(MeterValueSchema, { minItems: 1 }),
        idToken: IdTokenSchema,
        evse: EVSESchema,
        costDetails: CostDetailsSchema,
      },
    ),
    response: cls(
      {},
      {
        totalCost: number(),
        chargingPriority: integer(),
        idTokenInfo: IdTokenInfoSchema,
        updatedPersonalMessage: MessageContentSchema,
        updatedPersonalMessageExtra: array(MessageContentSchema, { minItems: 1, maxItems: 4 }),
        transactionLimit: TransactionLimitSchema,
      },
    ),
  },
  TriggerMessage: {
    request: cls(
      {
        requestedMessage: MessageTriggerEnumSchema,
      },
      {
        customTrigger: string({ maxLength: 50 }),
        evse: EVSESchema,
      },
    ),
    response: cls(
      {
        status: TriggerMessageStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  UnlockConnector: {
    request: cls({
      evseId: integer({ minimum: 0 }),
      connectorId: integer({ minimum: 0 }),
    }),
    response: cls(
      {
        status: UnlockStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  UnpublishFirmware: {
    request: cls({
      checksum: string({ maxLength: 32 }),
    }),
    response: cls({
      status: UnpublishFirmwareStatusEnumSchema,
    }),
  },
  UpdateDynamicSchedule: {
    request: cls({
      chargingProfileId: integer(),
      scheduleUpdate: ChargingScheduleUpdateSchema,
    }),
    response: cls(
      {
        status: ChargingProfileStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  UpdateFirmware: {
    request: cls(
      {
        requestId: integer(),
        firmware: FirmwareSchema,
      },
      {
        retries: integer({ minimum: 0 }),
        retryInterval: integer(),
      },
    ),
    response: cls(
      {
        status: UpdateFirmwareStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  UsePriorityCharging: {
    request: cls({
      transactionId: string({ maxLength: 36 }),
      activate: boolean(),
    }),
    response: cls(
      {
        status: PriorityChargingStatusEnumSchema,
      },
      {
        statusInfo: StatusInfoSchema,
      },
    ),
  },
  VatNumberValidation: {
    request: cls(
      {
        vatNumber: string({ maxLength: 20 }),
      },
      {
        evseId: integer({ minimum: 0 }),
      },
    ),
    response: cls(
      {
        vatNumber: string({ maxLength: 20 }),
        status: GenericStatusEnumSchema,
      },
      {
        evseId: integer({ minimum: 0 }),
        company: AddressSchema,
        statusInfo: StatusInfoSchema,
      },
    ),
  },
} as const;

export type Ocpp21Action = keyof typeof OCPP21_MESSAGES;
export type Ocpp21RequestOf<A extends Ocpp21Action> = Infer<(typeof OCPP21_MESSAGES)[A]['request']>;
/** The response of an action; never for the unconfirmed (SEND) ones. */
export type Ocpp21ResponseOf<A extends Ocpp21Action> =
  (typeof OCPP21_MESSAGES)[A]['response'] extends Schema<infer T> ? T : never;

/** Actions a Charging Station sends; DataTransfer goes both ways. */
export const OCPP21_CHARGING_STATION_ACTIONS = [
  'Authorize',
  'BatterySwap',
  'BootNotification',
  'ClearedChargingLimit',
  'ClosePeriodicEventStream',
  'DataTransfer',
  'FirmwareStatusNotification',
  'Get15118EVCertificate',
  'GetCertificateChainStatus',
  'GetCertificateStatus',
  'Heartbeat',
  'LogStatusNotification',
  'MeterValues',
  'NotifyChargingLimit',
  'NotifyCustomerInformation',
  'NotifyDERAlarm',
  'NotifyDERStartStop',
  'NotifyDisplayMessages',
  'NotifyEVChargingNeeds',
  'NotifyEVChargingSchedule',
  'NotifyEvent',
  'NotifyMonitoringReport',
  'NotifyPeriodicEventStream',
  'NotifyPriorityCharging',
  'NotifyReport',
  'NotifySettlement',
  'OpenPeriodicEventStream',
  'PublishFirmwareStatusNotification',
  'PullDynamicScheduleUpdate',
  'ReportChargingProfiles',
  'ReportDERControl',
  'ReservationStatusUpdate',
  'SecurityEventNotification',
  'SignCertificate',
  'StatusNotification',
  'TransactionEvent',
  'VatNumberValidation',
] as const satisfies readonly Ocpp21Action[];

/** Actions the CSMS sends to a Charging Station. */
export const OCPP21_CSMS_ACTIONS = [
  'AFRRSignal',
  'AdjustPeriodicEventStream',
  'CancelReservation',
  'CertificateSigned',
  'ChangeAvailability',
  'ChangeTransactionTariff',
  'ClearCache',
  'ClearChargingProfile',
  'ClearDERControl',
  'ClearDisplayMessage',
  'ClearTariffs',
  'ClearVariableMonitoring',
  'CostUpdated',
  'CustomerInformation',
  'DataTransfer',
  'DeleteCertificate',
  'GetBaseReport',
  'GetChargingProfiles',
  'GetCompositeSchedule',
  'GetDERControl',
  'GetDisplayMessages',
  'GetInstalledCertificateIds',
  'GetLocalListVersion',
  'GetLog',
  'GetMonitoringReport',
  'GetPeriodicEventStream',
  'GetReport',
  'GetTariffs',
  'GetTransactionStatus',
  'GetVariables',
  'InstallCertificate',
  'NotifyAllowedEnergyTransfer',
  'NotifyWebPaymentStarted',
  'PublishFirmware',
  'RequestBatterySwap',
  'RequestStartTransaction',
  'RequestStopTransaction',
  'ReserveNow',
  'Reset',
  'SendLocalList',
  'SetChargingProfile',
  'SetDERControl',
  'SetDefaultTariff',
  'SetDisplayMessage',
  'SetMonitoringBase',
  'SetMonitoringLevel',
  'SetNetworkProfile',
  'SetVariableMonitoring',
  'SetVariables',
  'TriggerMessage',
  'UnlockConnector',
  'UnpublishFirmware',
  'UpdateDynamicSchedule',
  'UpdateFirmware',
  'UsePriorityCharging',
] as const satisfies readonly Ocpp21Action[];

/** Actions sent as SEND (Part 4, 4.2.4): never answered. */
export const OCPP21_UNCONFIRMED_ACTIONS = [
  'NotifyPeriodicEventStream',
] as const satisfies readonly Ocpp21Action[];

export function isOcpp21Action(action: string): action is Ocpp21Action {
  return Object.hasOwn(OCPP21_MESSAGES, action);
}

/** The schema module reports the 1.6 spellings; OCPP-J 2.x corrected two of them. */
function as21<T>(result: ValidationResult<T>): ValidationResult<T> {
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

export function validateOcpp21Request<A extends Ocpp21Action>(
  action: A,
  payload: unknown,
): ValidationResult<Ocpp21RequestOf<A>> {
  return as21(validate(OCPP21_MESSAGES[action].request as Schema<Ocpp21RequestOf<A>>, payload));
}

/** Validates a response; an unconfirmed (SEND) action has none, so any payload is refused. */
export function validateOcpp21Response<A extends Ocpp21Action>(
  action: A,
  payload: unknown,
): ValidationResult<Ocpp21ResponseOf<A>> {
  const schema = OCPP21_MESSAGES[action].response as Schema<Ocpp21ResponseOf<A>> | undefined;
  if (schema === undefined) {
    return {
      ok: false,
      errorCode: 'FormatViolation',
      issues: [
        {
          path: '$',
          message: `${action} is unconfirmed and has no response`,
          errorCode: 'FormatViolation',
        },
      ],
    };
  }
  return as21(validate(schema, payload));
}
